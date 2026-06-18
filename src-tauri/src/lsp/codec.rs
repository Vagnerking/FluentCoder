//! LSP base-protocol framing over stdio: `Content-Length: N\r\n\r\n<json>`.
//!
//! Deliberately minimal — no `lsp-server`/`async-lsp` crate — so the dependency
//! surface stays small. Reusable by every language server (C#, Razor, TS).

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Reads one complete LSP message and returns its JSON body as a `String`.
///
/// Parses the `Content-Length` header (other headers are ignored), consumes the
/// blank `\r\n` separator, then reads exactly that many bytes of UTF-8 payload.
/// Returns `Ok(None)` on clean EOF before any header.
pub async fn read_message<R>(reader: &mut R) -> std::io::Result<Option<String>>
where
    R: AsyncBufRead + Unpin,
{
    let mut content_length: Option<usize> = None;

    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            // EOF. If we already saw a header this is a truncated frame.
            return if content_length.is_some() {
                Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "EOF in the middle of an LSP frame",
                ))
            } else {
                Ok(None)
            };
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            // Blank line: end of headers.
            break;
        }

        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = Some(value.trim().parse().map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid Content-Length")
            })?);
        }
        // Other headers (e.g. Content-Type) are ignored.
    }

    let len = content_length.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "missing Content-Length header")
    })?;

    let mut buf = vec![0u8; len];
    read_exact(reader, &mut buf).await?;
    String::from_utf8(buf)
        .map(Some)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "non-UTF8 LSP payload"))
}

/// Reads exactly `buf.len()` bytes from a generic async reader.
async fn read_exact<R>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader.read(&mut buf[filled..]).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "EOF while reading LSP payload",
            ));
        }
        filled += n;
    }
    Ok(())
}

/// Writes one LSP message: the `Content-Length` header followed by the JSON body.
pub async fn write_message<W>(writer: &mut W, json: &str) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let header = format!("Content-Length: {}\r\n\r\n", json.len());
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(json.as_bytes()).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn round_trip() {
        let payload = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;

        let mut framed: Vec<u8> = Vec::new();
        write_message(&mut framed, payload).await.unwrap();

        // The frame must start with the correct header.
        let header = format!("Content-Length: {}\r\n\r\n", payload.len());
        assert!(framed.starts_with(header.as_bytes()));

        let mut reader = BufReader::new(Cursor::new(framed));
        let read_back = read_message(&mut reader).await.unwrap();
        assert_eq!(read_back.as_deref(), Some(payload));
    }

    #[tokio::test]
    async fn clean_eof_returns_none() {
        let mut reader = BufReader::new(Cursor::new(Vec::<u8>::new()));
        let result = read_message(&mut reader).await.unwrap();
        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn two_messages_in_sequence() {
        let a = r#"{"id":1}"#;
        let b = r#"{"id":2}"#;
        let mut framed: Vec<u8> = Vec::new();
        write_message(&mut framed, a).await.unwrap();
        write_message(&mut framed, b).await.unwrap();

        let mut reader = BufReader::new(Cursor::new(framed));
        assert_eq!(read_message(&mut reader).await.unwrap().as_deref(), Some(a));
        assert_eq!(read_message(&mut reader).await.unwrap().as_deref(), Some(b));
        assert_eq!(read_message(&mut reader).await.unwrap(), None);
    }
}
