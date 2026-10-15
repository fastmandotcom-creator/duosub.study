//! In-process event bus: a bounded replay ring + tokio broadcast to live SSE subscribers.
//!
//! The ring is the poll fallback's source of truth: `GET /events?since=N` is served from the ring
//! with no lock held by any live connection. A dead bridge costs a consumer at most the ring.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, atomic::AtomicU64};

use tokio::sync::broadcast;

use crate::contract::BridgeEvent;

/// Replay window. ~30 s of real meeting traffic is far more than any reconnect needs.
pub const RING_CAPACITY: usize = 2048;
/// Idle subscribers exceeding this miss nothing the ring holds; slower ones just lag into the poll
/// path. Sized above the ring so a live consumer can always catch up from memory.
pub const BROADCAST_CAPACITY: usize = 4096;

#[derive(Clone)]
pub struct EventBus {
    ring: Arc<Mutex<VecDeque<BridgeEvent>>>,
    next_seq: Arc<AtomicU64>,
    tx: broadcast::Sender<BridgeEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        Self {
            ring: Arc::new(Mutex::new(VecDeque::with_capacity(RING_CAPACITY))),
            next_seq: Arc::new(AtomicU64::new(0)),
            tx: broadcast::channel(BROADCAST_CAPACITY).0,
        }
    }

    /// Allocates the next `seq`, records the event in the ring, and forwards it to live
    /// subscribers. Drops the event if nobody is live (the ring keeps it for poll/reconnect).
    pub fn publish(&self, event: &BridgeEvent) -> u64 {
        let seq = self
            .next_seq
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        let mut stamped = event.clone();
        stamped.seq = seq;
        {
            let mut ring = self.ring.lock().expect("event bus poisoned");
            ring.push_back(stamped.clone());
            // Trim the oldest once past capacity — `since` queries past the window report the gap.
            while ring.len() > RING_CAPACITY {
                ring.pop_front();
            }
        }
        // No live subscriber is not an error: the ring is the recovery path.
        let _ = self.tx.send(stamped);
        seq
    }

    /// Events with `seq > since` still in the ring, oldest first.
    pub fn replay_after(&self, since: u64) -> Vec<BridgeEvent> {
        let ring = self.ring.lock().expect("event bus poisoned");
        ring.iter().filter(|e| e.seq > since).cloned().collect()
    }

    /// Oldest `seq` still held by the ring, or `None` when the ring is empty.
    pub fn oldest_seq(&self) -> Option<u64> {
        let ring = self.ring.lock().expect("event bus poisoned");
        ring.front().map(|e| e.seq)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BridgeEvent> {
        self.tx.subscribe()
    }

    /// The last `seq` ever published (0 when idle) — what a reconnecting poller resumes from.
    pub fn latest_seq(&self) -> u64 {
        self.next_seq.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::EventBody;

    fn event(seq: u64) -> BridgeEvent {
        BridgeEvent {
            seq,
            ts: 0,
            body: EventBody::SessionStopped {
                session_id: "s".to_owned(),
                segment_count: 0,
            },
        }
    }

    #[test]
    fn ring_keeps_newest_and_replays_after_marker() {
        let bus = EventBus::new();
        for i in 1..=10 {
            bus.publish(&event(i));
        }
        let replay = bus.replay_after(5);
        assert_eq!(replay.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![6, 7, 8, 9, 10]);
        assert_eq!(bus.oldest_seq(), Some(1));
        assert_eq!(bus.latest_seq(), 10);
    }

    #[test]
    fn ring_trims_oldest_past_capacity() {
        let bus = EventBus::new();
        for i in 1..=RING_CAPACITY as u64 + 5 {
            bus.publish(&event(i));
        }
        // The first 5 seqs rolled off: the ring now holds exactly the newest CAPACITY events.
        assert_eq!(bus.replay_after(5).len(), RING_CAPACITY);
        assert_eq!(bus.replay_after(0).len(), RING_CAPACITY, "ring is capped, not unbounded");
        assert!(bus.replay_after(RING_CAPACITY as u64 + 5).is_empty());
        assert_eq!(bus.oldest_seq(), Some(6));
        assert_eq!(bus.latest_seq(), (RING_CAPACITY + 5) as u64);
    }
}
