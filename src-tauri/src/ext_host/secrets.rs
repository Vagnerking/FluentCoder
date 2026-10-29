//! `context.secrets` das extensões hospedadas, no cofre de credenciais do SO
//! (Secret Service/libsecret no Linux, Keychain no macOS, Credential Manager no
//! Windows) via crate `keyring`.
//!
//! O sidecar pede com uma linha `{"event":"secrets","requestId":N,"op":…}` no
//! stdout; o leitor do stdout (mod.rs) desvia essas linhas para cá — elas
//! nunca chegam ao frontend — e a resposta volta pelo stdin como
//! `{"method":"respond","params":{"requestId":N,"result":{…}}}`. Falha do cofre
//! (sem Secret Service, cofre trancado e recusado…) responde `ok:false` e o
//! sidecar cai no arquivo JSON 0600 (fallback documentado).

use serde::Deserialize;
use serde_json::{json, Value};

/// Serviço sob o qual os segredos ficam no cofre do SO.
pub const SERVICE: &str = "Fluent Coder (extensões VS Code)";

/// Prefixo barato para reconhecer a linha sem parsear todo o stdout.
pub const LINE_PREFIX: &str = "{\"event\":\"secrets\"";

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SecretRequest {
    pub request_id: u64,
    pub op: String,
    /// `<extensionId>/<key>` (o sidecar monta; validado aqui).
    pub account: String,
    #[serde(default)]
    pub value: Option<String>,
}

/// Valida conta: id de extensão (`publisher.name`) + `/` + chave não vazia,
/// sem caracteres de controle e com tamanho limitado.
pub fn valid_account(account: &str) -> bool {
    let Some((ext, key)) = account.split_once('/') else {
        return false;
    };
    let ext_ok = !ext.is_empty()
        && ext.len() <= 128
        && ext.contains('.')
        && ext.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    ext_ok && !key.is_empty() && account.len() <= 512 && !account.chars().any(|c| c.is_control())
}

/// Executa um pedido e devolve o `result` do `respond`.
pub fn handle(req: &SecretRequest) -> Value {
    if !valid_account(&req.account) {
        return json!({ "ok": false, "error": "conta de segredo inválida" });
    }
    let entry = match keyring::Entry::new(SERVICE, &req.account) {
        Ok(e) => e,
        Err(e) => return json!({ "ok": false, "error": e.to_string() }),
    };
    match req.op.as_str() {
        "get" => match entry.get_password() {
            Ok(v) => json!({ "ok": true, "value": v }),
            Err(keyring::Error::NoEntry) => json!({ "ok": true, "value": null }),
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        },
        "store" => {
            let Some(v) = req.value.as_deref() else {
                return json!({ "ok": false, "error": "valor ausente" });
            };
            if v.len() > 64 * 1024 {
                return json!({ "ok": false, "error": "segredo grande demais" });
            }
            match entry.set_password(v) {
                Ok(()) => json!({ "ok": true }),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            }
        }
        "delete" => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => json!({ "ok": true }),
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        },
        other => json!({ "ok": false, "error": format!("operação desconhecida: {other}") }),
    }
}

/// Linha de resposta para o stdin do sidecar.
pub fn respond_line(request_id: u64, result: Value) -> String {
    json!({ "method": "respond", "params": { "requestId": request_id, "result": result } }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_are_validated() {
        assert!(valid_account("anthropic.claude-code/token"));
        assert!(valid_account("openai.chatgpt/a b/c"));
        assert!(!valid_account("token"));
        assert!(!valid_account("/token"));
        assert!(!valid_account("noperiod/token"));
        assert!(!valid_account("a.b/"));
        assert!(!valid_account("a.b/x\ny"));
        assert!(!valid_account("a b.c/x"));
    }

    /// Toca o cofre REAL do SO (cria e apaga uma entrada de teste). Manual:
    /// `cargo test --lib roundtrip_in_os_keyring -- --ignored`.
    #[test]
    #[ignore]
    fn roundtrip_in_os_keyring() {
        let req = |op: &str, value: Option<&str>| SecretRequest {
            request_id: 1,
            op: op.into(),
            account: "fluent.test/roundtrip".into(),
            value: value.map(String::from),
        };
        assert_eq!(handle(&req("store", Some("s3gr3do")))["ok"], true);
        assert_eq!(handle(&req("get", None))["value"], "s3gr3do");
        assert_eq!(handle(&req("delete", None))["ok"], true);
        assert_eq!(handle(&req("get", None))["value"], serde_json::Value::Null);
    }

    #[test]
    fn request_line_parses_and_invalid_is_refused() {
        let line = r#"{"event":"secrets","requestId":7,"op":"get","account":"bad"}"#;
        assert!(line.starts_with(LINE_PREFIX));
        let req: SecretRequest = serde_json::from_str(line).unwrap();
        assert_eq!(req.request_id, 7);
        assert_eq!(handle(&req)["ok"], false);
        let out = respond_line(7, json!({"ok": true}));
        assert!(out.contains("\"requestId\":7") && !out.contains('\n'));
    }
}
