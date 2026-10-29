//! Protocol responses for PTYs without a terminal emulator.

// portable-pty requests the parent cursor position on Windows. With no UI,
// there is no xterm instance to answer it; keep the PTY protocol moving here.
// The request can be split across arbitrary pipe reads.
#[derive(Default)]
pub(crate) struct CursorQueryResponder {
    matched: usize,
}

impl CursorQueryResponder {
    pub(crate) fn feed(
        &mut self,
        bytes: &[u8],
        writer: &mut dyn std::io::Write,
    ) -> std::io::Result<()> {
        const QUERY: &[u8] = b"\x1b[6n";
        for &byte in bytes {
            if byte == QUERY[self.matched] {
                self.matched += 1;
                if self.matched == QUERY.len() {
                    self.matched = 0;
                    writer.write_all(b"\x1b[1;1R")?;
                    writer.flush()?;
                }
            } else {
                self.matched = usize::from(byte == QUERY[0]);
            }
        }
        Ok(())
    }
}

/// Test PTYs have both simulated keyboard input and protocol replies.
#[cfg(test)]
#[derive(Clone)]
pub(crate) struct SharedWriter(std::sync::Arc<std::sync::Mutex<Box<dyn std::io::Write + Send>>>);

#[cfg(test)]
impl SharedWriter {
    pub(crate) fn new(writer: Box<dyn std::io::Write + Send>) -> Self {
        Self(std::sync::Arc::new(std::sync::Mutex::new(writer)))
    }
}

#[cfg(test)]
impl std::io::Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("PTY writer poisoned"))?
            .write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0
            .lock()
            .map_err(|_| std::io::Error::other("PTY writer poisoned"))?
            .flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn headless_cursor_reply_handles_pipe_boundaries_without_replying_to_text() {
        for split in 0..=4 {
            let mut responder = CursorQueryResponder::default();
            let mut replies = Vec::new();
            responder
                .feed(b"plain text [6n \x1b[31m", &mut replies)
                .unwrap();
            assert!(replies.is_empty());
            let query = b"\x1b[6n";
            responder.feed(&query[..split], &mut replies).unwrap();
            responder.feed(&query[split..], &mut replies).unwrap();
            assert_eq!(replies, b"\x1b[1;1R");
            responder.feed(b"\x1b\x1b[6n", &mut replies).unwrap();
            assert_eq!(replies, b"\x1b[1;1R\x1b[1;1R");
        }
    }
}
