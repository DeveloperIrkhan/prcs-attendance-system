/**
 * Chart palette for attendance statuses.
 *
 * Rules of the set: one family of richly saturated hues at similar weight so no
 * single series dominates a stacked bar, hues spaced around the wheel so the
 * seven categories stay distinguishable (including for red/green colour
 * blindness, where green reads as dark and red as bright), and nothing as neon
 * as a pure #ff0000 next to the red brand accent. These are used as fills and
 * swatches only, never as text.
 */
export const STATUS_COLORS = {
  /** On time — forest green, pairs with the green "Present" badge. */
  present: "#15803d",
  /** Late — honey amber; readable on white, still clearly not orange. */
  late: "#d97706",
  /** Absent — signal red, a touch brighter than the #991b1b brand red. */
  absent: "#dc2626",
  /** Missing punch — sky blue. */
  missing: "#0284c7",
  /** On leave — indigo, calm but distinct from the greys. */
  leave: "#4f46e5",
  /** Holiday — orchid, deep enough to sit quietly in a bar stub. */
  holiday: "#a21caf",
  /** Not in yet — soft slate: present in the data, not yet a status. */
  notInYet: "#94a3b8",
  /** Weekly off / no attendance expected — faint neutral stub. */
  dayOff: "#cbd5e1",
} as const;
