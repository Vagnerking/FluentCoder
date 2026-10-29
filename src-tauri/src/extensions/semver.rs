//! SemVer mínimo para versões de extensões (`major.minor.patch[-pre][+build]`).
//! Comparação conforme semver.org §11: pré-release < release; identificadores
//! numéricos comparados como números. Build metadata é ignorada.

use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Vec<String>,
}

impl Version {
    pub fn parse(s: &str) -> Option<Version> {
        let s = s.trim().trim_start_matches('v');
        let s = s.split('+').next()?;
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, Some(p)),
            None => (s, None),
        };
        let mut it = core.split('.');
        let num = |p: Option<&str>| -> Option<u64> {
            let p = p?;
            if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            p.parse().ok()
        };
        let major = num(it.next())?;
        let minor = num(it.next())?;
        let patch = num(it.next())?;
        if it.next().is_some() {
            return None;
        }
        let pre = match pre {
            Some(p) if p.is_empty() => return None,
            Some(p) => p.split('.').map(str::to_string).collect(),
            None => Vec::new(),
        };
        Some(Version { major, minor, patch, pre })
    }
}

fn cmp_pre(a: &[String], b: &[String]) -> Ordering {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    for (x, y) in a.iter().zip(b.iter()) {
        let o = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(nx), Ok(ny)) => nx.cmp(&ny),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            _ => x.cmp(y),
        };
        if o != Ordering::Equal {
            return o;
        }
    }
    a.len().cmp(&b.len())
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| cmp_pre(&self.pre, &other.pre))
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Compara duas versões; as que não são SemVer caem numa comparação numérica
/// por partes (como o VS Code faz com versões "26.1007.21434").
pub fn compare(a: &str, b: &str) -> Ordering {
    match (Version::parse(a), Version::parse(b)) {
        (Some(x), Some(y)) => x.cmp(&y),
        _ => {
            let parts = |s: &str| s.split(['.', '-']).map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
            let (pa, pb) = (parts(a), parts(b));
            for i in 0..pa.len().max(pb.len()) {
                let o = pa.get(i).unwrap_or(&0).cmp(pb.get(i).unwrap_or(&0));
                if o != Ordering::Equal {
                    return o;
                }
            }
            Ordering::Equal
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_orders() {
        assert!(Version::parse("1.2.3").is_some());
        assert!(Version::parse("1.2").is_none());
        assert!(Version::parse("1.2.x").is_none());
        assert!(Version::parse("1.2.3-").is_none());
        assert_eq!(compare("2.1.296", "2.1.30"), Ordering::Greater);
        assert_eq!(compare("26.1007.21434", "26.908.40401"), Ordering::Greater);
        assert_eq!(compare("1.0.0-alpha", "1.0.0"), Ordering::Less);
        assert_eq!(compare("1.0.0-alpha.1", "1.0.0-alpha.beta"), Ordering::Less);
        assert_eq!(compare("1.0.0-beta.2", "1.0.0-beta.11"), Ordering::Less);
        assert_eq!(compare("1.0.0+build.5", "1.0.0"), Ordering::Equal);
        assert_eq!(compare("v1.4.0", "1.3.9"), Ordering::Greater);
    }
}
