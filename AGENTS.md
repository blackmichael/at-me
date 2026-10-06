# Agent Notes

## Client Snapshot Loading State

`App` renders once before `/api/bootstrap` returns. Keep the `empty` snapshot in
`src/client/main.tsx` structurally complete for every field consumed by child
components, especially arrays passed to `.map()`, `.some()`, or `.reduce()`.
When adding a snapshot field, update both the server snapshot and `empty` in the
same change so the loading render cannot throw.
