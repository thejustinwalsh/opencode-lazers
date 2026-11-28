pub trait Sink {
    fn write(&mut self, bytes: &[u8]) -> usize;
}

pub struct StagingRing {
    buffer: Vec<u8>,
    capacity: usize,
}

impl Sink for StagingRing {
    fn write(&mut self, bytes: &[u8]) -> usize {
        let free = self.capacity - self.buffer.len();
        let count = bytes.len().min(free);
        self.buffer.extend_from_slice(&bytes[..count]);
        count
    }
}
