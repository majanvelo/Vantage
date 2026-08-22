# apps/mobile

The **phone app**. Target is Expo / React Native (per SPEC.md §1.3 and the
stack notes in the spec appendix; Phase 1 verification can be web-based
multi-view if a native build isn't ready).

What belongs here:
- Event creation UI (solo + collaborative modes; see §1.2 and §2.2).
- Collaborative pool / invite / join experience.
- Clip upload UI (direct-to-storage via presigned URLs; see §3.3).
- Multi-view playback for Phase 1 verification — takes `sync_placements` and
  plays aligned clips on a common timeline clock (§3.4, §2.4 and Phase 1 §7).

Phase 1 scope only for the first build. Later phases add render/export UI and
finished-film playback.
