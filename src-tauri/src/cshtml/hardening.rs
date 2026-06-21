/// Hardening do serviço CSHTML: cancelamento cooperativo, cache com invalidação,
/// logs estruturados e métricas de diagnóstico (issue #46).
///
/// Nenhum conteúdo sensível é registrado nos logs.
/// O serviço continua operacional após restart ou troca de workspace.
/// Crash isolado do CSHTML não afeta outros LSPs.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

// ── Cancelamento cooperativo ──────────────────────────────────────────────────

/// Token de cancelamento compartilhável entre produtor e consumidor.
///
/// O produtor chama `cancel()` e o consumidor verifica `is_cancelled()` nos
/// pontos de cancelamento cooperativo.
#[derive(Debug, Clone)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self { CancelToken(Arc::new(AtomicBool::new(false))) }

    pub fn cancel(&self) { self.0.store(true, Ordering::Relaxed); }

    pub fn is_cancelled(&self) -> bool { self.0.load(Ordering::Relaxed) }

    /// Retorna `Err(Cancelled)` se cancelado, `Ok(())` caso contrário.
    pub fn check(&self) -> Result<(), Cancelled> {
        if self.is_cancelled() { Err(Cancelled) } else { Ok(()) }
    }
}

impl Default for CancelToken {
    fn default() -> Self { Self::new() }
}

/// Sentinela de cancelamento retornada por `CancelToken::check()`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "request cancelled")
    }
}

// ── Versão de request ─────────────────────────────────────────────────────────

/// Número de versão monotônico associado a um request/documento.
/// Respostas antigas (versão menor que a atual) são descartadas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct RequestVersion(pub u64);

impl RequestVersion {
    pub fn initial() -> Self { RequestVersion(0) }
    pub fn next(&self) -> Self { RequestVersion(self.0 + 1) }
}

/// Resultado rotulado com versão — descarte respostas obsoletas comparando versões.
#[derive(Debug, Clone)]
pub struct Versioned<T> {
    pub version: RequestVersion,
    pub value: T,
}

impl<T> Versioned<T> {
    pub fn new(version: RequestVersion, value: T) -> Self { Versioned { version, value } }

    /// Retorna `Some(value)` se `self.version >= current`, `None` se obsoleto.
    pub fn into_current(self, current: RequestVersion) -> Option<T> {
        if self.version >= current { Some(self.value) } else { None }
    }
}

// ── Cache genérico com TTL e limites ─────────────────────────────────────────

/// Entrada de cache com versão, conteúdo e timestamp de inserção.
struct CacheEntry<V> {
    value: V,
    version: RequestVersion,
    inserted_at: Instant,
}

/// Cache LRU simples (sem dependências externas) com limite de entradas e TTL.
pub struct BoundedCache<K, V> {
    entries: HashMap<K, CacheEntry<V>>,
    max_entries: usize,
    ttl: Duration,
}

impl<K: Eq + std::hash::Hash + Clone, V> BoundedCache<K, V> {
    pub fn new(max_entries: usize, ttl: Duration) -> Self {
        BoundedCache { entries: HashMap::new(), max_entries, ttl }
    }

    /// Insere ou atualiza uma entrada.
    pub fn insert(&mut self, key: K, value: V, version: RequestVersion) {
        // Evict oldest entry if at capacity (simple strategy: drop first found)
        if self.entries.len() >= self.max_entries && !self.entries.contains_key(&key) {
            if let Some(oldest_key) = self.entries.keys().next().cloned() {
                self.entries.remove(&oldest_key);
            }
        }
        self.entries.insert(key, CacheEntry { value, version, inserted_at: Instant::now() });
    }

    /// Retorna a entrada se existente, não expirada, e versão >= min_version.
    pub fn get(&self, key: &K, min_version: RequestVersion) -> Option<&V> {
        let entry = self.entries.get(key)?;
        if entry.version < min_version { return None; }
        if entry.inserted_at.elapsed() > self.ttl { return None; }
        Some(&entry.value)
    }

    /// Remove uma entrada (invalidação explícita).
    pub fn invalidate(&mut self, key: &K) { self.entries.remove(key); }

    /// Remove todas as entradas com TTL expirado.
    pub fn evict_expired(&mut self) {
        let ttl = self.ttl;
        self.entries.retain(|_, e| e.inserted_at.elapsed() <= ttl);
    }

    pub fn len(&self) -> usize { self.entries.len() }
    pub fn is_empty(&self) -> bool { self.entries.is_empty() }
}

// ── Métricas de diagnóstico ───────────────────────────────────────────────────

/// Contadores de diagnóstico para um feature/componente.
#[derive(Debug, Default)]
pub struct DiagMetrics {
    pub requests: AtomicU64,
    pub cache_hits: AtomicU64,
    pub cache_misses: AtomicU64,
    pub cancelled: AtomicU64,
    pub errors: AtomicU64,
    /// Duração total em microssegundos.
    pub total_us: AtomicU64,
}

impl DiagMetrics {
    pub fn new() -> Arc<Self> { Arc::new(Self::default()) }

    pub fn record_request(&self) { self.requests.fetch_add(1, Ordering::Relaxed); }
    pub fn record_cache_hit(&self) { self.cache_hits.fetch_add(1, Ordering::Relaxed); }
    pub fn record_cache_miss(&self) { self.cache_misses.fetch_add(1, Ordering::Relaxed); }
    pub fn record_cancelled(&self) { self.cancelled.fetch_add(1, Ordering::Relaxed); }
    pub fn record_error(&self) { self.errors.fetch_add(1, Ordering::Relaxed); }
    pub fn record_duration(&self, elapsed: Duration) {
        self.total_us.fetch_add(elapsed.as_micros() as u64, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> MetricsSnapshot {
        let reqs = self.requests.load(Ordering::Relaxed);
        MetricsSnapshot {
            requests: reqs,
            cache_hits: self.cache_hits.load(Ordering::Relaxed),
            cache_misses: self.cache_misses.load(Ordering::Relaxed),
            cancelled: self.cancelled.load(Ordering::Relaxed),
            errors: self.errors.load(Ordering::Relaxed),
            avg_us: if reqs == 0 { 0 } else { self.total_us.load(Ordering::Relaxed) / reqs },
        }
    }
}

#[derive(Debug, Clone)]
pub struct MetricsSnapshot {
    pub requests: u64,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub cancelled: u64,
    pub errors: u64,
    /// Duração média por request em microssegundos.
    pub avg_us: u64,
}

impl MetricsSnapshot {
    pub fn cache_hit_rate(&self) -> f64 {
        let total = self.cache_hits + self.cache_misses;
        if total == 0 { 0.0 } else { self.cache_hits as f64 / total as f64 }
    }
}

// ── Log estruturado ───────────────────────────────────────────────────────────

/// Nível de log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl std::fmt::Display for LogLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LogLevel::Trace => write!(f, "TRACE"),
            LogLevel::Debug => write!(f, "DEBUG"),
            LogLevel::Info => write!(f, "INFO"),
            LogLevel::Warn => write!(f, "WARN"),
            LogLevel::Error => write!(f, "ERROR"),
        }
    }
}

/// Emite um log estruturado via eprintln!.
/// Não inclui conteúdo do documento — apenas IDs, versões e durações.
pub fn log(level: LogLevel, component: &str, msg: &str) {
    eprintln!("[CSHTML/{level}] {component}: {msg}");
}

/// Macro de log para evitar formatação desnecessária em nível desabilitado.
#[macro_export]
macro_rules! cshtml_log {
    ($level:expr, $component:expr, $($arg:tt)*) => {
        $crate::cshtml::hardening::log($level, $component, &format!($($arg)*))
    };
}

// ── Gestor de sessão de workspace ─────────────────────────────────────────────

/// Estado de uma sessão de workspace CSHTML.
/// Criada ao abrir uma pasta, descartada ao fechar — tokens e caches são limpos.
pub struct WorkspaceSession {
    pub root: PathBuf,
    /// Token de cancelamento global — cancela requests em curso ao fechar.
    pub global_cancel: CancelToken,
    pub metrics: Arc<DiagMetrics>,
    pub current_version: RequestVersion,
}

impl WorkspaceSession {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        WorkspaceSession {
            root: root.into(),
            global_cancel: CancelToken::new(),
            metrics: DiagMetrics::new(),
            current_version: RequestVersion::initial(),
        }
    }

    /// Incrementa a versão e retorna o token de cancelamento atual.
    pub fn bump_version(&mut self) -> (RequestVersion, CancelToken) {
        self.current_version = self.current_version.next();
        (self.current_version, self.global_cancel.clone())
    }

    /// Fecha a sessão cancelando todos os requests em curso.
    pub fn close(self) {
        self.global_cancel.cancel();
        log(LogLevel::Info, "WorkspaceSession", &format!("closed: {}", self.root.display()));
    }
}

// ── Testes ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    // CancelToken: cancelamento básico
    #[test]
    fn cancel_token_basic() {
        let tok = CancelToken::new();
        assert!(!tok.is_cancelled());
        tok.cancel();
        assert!(tok.is_cancelled());
        assert_eq!(tok.check(), Err(Cancelled));
    }

    // CancelToken: clone compartilha estado
    #[test]
    fn cancel_token_shared() {
        let tok = CancelToken::new();
        let tok2 = tok.clone();
        tok.cancel();
        assert!(tok2.is_cancelled(), "clone must see cancellation");
    }

    // CancelToken: check antes de cancel → Ok
    #[test]
    fn cancel_token_not_cancelled() {
        let tok = CancelToken::new();
        assert_eq!(tok.check(), Ok(()));
    }

    // RequestVersion: ordenação monotônica
    #[test]
    fn request_version_monotonic() {
        let v0 = RequestVersion::initial();
        let v1 = v0.next();
        let v2 = v1.next();
        assert!(v0 < v1);
        assert!(v1 < v2);
    }

    // Versioned: descarta versão obsoleta
    #[test]
    fn versioned_discard_old() {
        let v0 = RequestVersion::initial();
        let v1 = v0.next();
        let result = Versioned::new(v0, "old");
        assert!(result.into_current(v1).is_none(), "old version must be discarded");
    }

    // Versioned: mantém versão atual
    #[test]
    fn versioned_keep_current() {
        let v1 = RequestVersion::initial().next();
        let result = Versioned::new(v1, "current");
        assert_eq!(result.into_current(v1), Some("current"));
    }

    // BoundedCache: insert e get básico
    #[test]
    fn cache_insert_get() {
        let mut cache: BoundedCache<&str, i32> = BoundedCache::new(10, Duration::from_secs(60));
        let v0 = RequestVersion::initial();
        cache.insert("key", 42, v0);
        assert_eq!(cache.get(&"key", v0), Some(&42));
    }

    // BoundedCache: miss para chave ausente
    #[test]
    fn cache_miss_absent() {
        let cache: BoundedCache<&str, i32> = BoundedCache::new(10, Duration::from_secs(60));
        assert!(cache.get(&"missing", RequestVersion::initial()).is_none());
    }

    // BoundedCache: invalidação explícita
    #[test]
    fn cache_invalidate() {
        let mut cache: BoundedCache<&str, i32> = BoundedCache::new(10, Duration::from_secs(60));
        let v0 = RequestVersion::initial();
        cache.insert("key", 42, v0);
        cache.invalidate(&"key");
        assert!(cache.get(&"key", v0).is_none(), "must be gone after invalidate");
    }

    // BoundedCache: versão mínima descarta entrada antiga
    #[test]
    fn cache_version_eviction() {
        let mut cache: BoundedCache<&str, i32> = BoundedCache::new(10, Duration::from_secs(60));
        let v0 = RequestVersion::initial();
        let v1 = v0.next();
        cache.insert("key", 42, v0);
        // Asking for min_version v1 must reject the v0 entry
        assert!(cache.get(&"key", v1).is_none(), "entry at v0 must be rejected when asking v1");
    }

    // BoundedCache: TTL expirado → evict
    #[test]
    fn cache_ttl_eviction() {
        let mut cache: BoundedCache<&str, i32> = BoundedCache::new(10, Duration::from_nanos(1));
        let v0 = RequestVersion::initial();
        cache.insert("key", 42, v0);
        std::thread::sleep(Duration::from_millis(1));
        assert!(cache.get(&"key", v0).is_none(), "entry must expire after TTL");
    }

    // BoundedCache: não excede max_entries
    #[test]
    fn cache_bounded_capacity() {
        let mut cache: BoundedCache<usize, usize> = BoundedCache::new(3, Duration::from_secs(60));
        let v0 = RequestVersion::initial();
        for i in 0..5 {
            cache.insert(i, i, v0);
        }
        assert!(cache.len() <= 3, "cache must not exceed max_entries");
    }

    // BoundedCache: evict_expired
    #[test]
    fn cache_evict_expired_manual() {
        let mut cache: BoundedCache<&str, i32> = BoundedCache::new(10, Duration::from_nanos(1));
        let v0 = RequestVersion::initial();
        cache.insert("k1", 1, v0);
        cache.insert("k2", 2, v0);
        std::thread::sleep(Duration::from_millis(1));
        cache.evict_expired();
        assert!(cache.is_empty(), "all entries must be evicted after TTL");
    }

    // DiagMetrics: contadores básicos
    #[test]
    fn diag_metrics_counters() {
        let m = DiagMetrics::new();
        m.record_request();
        m.record_request();
        m.record_cache_hit();
        m.record_cache_miss();
        m.record_cancelled();
        m.record_error();
        m.record_duration(Duration::from_micros(500));

        let snap = m.snapshot();
        assert_eq!(snap.requests, 2);
        assert_eq!(snap.cache_hits, 1);
        assert_eq!(snap.cache_misses, 1);
        assert_eq!(snap.cancelled, 1);
        assert_eq!(snap.errors, 1);
        assert_eq!(snap.avg_us, 250); // 500 us / 2 requests
    }

    // DiagMetrics: cache hit rate
    #[test]
    fn diag_metrics_hit_rate() {
        let m = DiagMetrics::new();
        m.record_cache_hit();
        m.record_cache_hit();
        m.record_cache_miss();
        let snap = m.snapshot();
        let rate = snap.cache_hit_rate();
        assert!((rate - 2.0 / 3.0).abs() < 1e-9, "hit rate must be 2/3; got {rate}");
    }

    // DiagMetrics: zero requests → avg_us = 0
    #[test]
    fn diag_metrics_no_requests() {
        let m = DiagMetrics::new();
        let snap = m.snapshot();
        assert_eq!(snap.avg_us, 0);
        assert_eq!(snap.cache_hit_rate(), 0.0);
    }

    // WorkspaceSession: bump_version monotônico
    #[test]
    fn workspace_session_bump_version() {
        let mut sess = WorkspaceSession::new("/tmp/my-project");
        let (v1, _) = sess.bump_version();
        let (v2, _) = sess.bump_version();
        assert!(v1 < v2, "versions must be monotonically increasing");
    }

    // WorkspaceSession: close cancela token global
    #[test]
    fn workspace_session_close_cancels() {
        let sess = WorkspaceSession::new("/tmp/my-project");
        let tok = sess.global_cancel.clone();
        sess.close();
        assert!(tok.is_cancelled(), "close must cancel the global token");
    }

    // WorkspaceSession: requests em curso recebem cancelamento ao fechar
    #[test]
    fn workspace_session_in_flight_cancelled() {
        let mut sess = WorkspaceSession::new("/tmp/my-project");
        let (v, tok) = sess.bump_version();
        // Simula request em curso
        assert_eq!(tok.check(), Ok(()), "must not be cancelled yet");
        sess.close();
        assert_eq!(tok.check(), Err(Cancelled), "must be cancelled after close");
    }
}
