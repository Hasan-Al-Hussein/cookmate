/** Design targets, not claims of measured frame rate. */
export const motionTokens = {
  delay: { pending: 150 },
  duration: {
    pressIn: 70,
    pressOut: 110,
    micro: 130,
    fade: 160,
    content: 200,
    disclosure: 220,
    sheet: 280,
    pageFallback: 280,
    launchExit: 240,
  },
  distance: { micro: 4, contentEnter: 8, maximumDecorativeShift: 12 },
  scale: { press: 0.985, iconPeak: 1.06 },
} as const;
