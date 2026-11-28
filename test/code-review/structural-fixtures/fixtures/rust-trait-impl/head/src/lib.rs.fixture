pub trait Sink {
    fn write(&mut self, bytes: &[u8]) -> usize;
}

pub struct StagingRing {
    buffer: Vec<u8>,
    capacity: usize,
}

impl Sink for StagingRing {
    fn write(&mut self, bytes: &[u8]) -> usize {
        if bytes.len() > self.capacity {
            self.buffer.clear();
            let tail = &bytes[bytes.len() - self.capacity..];
            self.buffer.extend_from_slice(tail);
            return bytes.len();
        }
        let free = self.capacity - self.buffer.len();
        let count = bytes.len().min(free);
        self.buffer.extend_from_slice(&bytes[..count]);
        count
    }
}
