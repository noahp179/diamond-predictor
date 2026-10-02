/**
 * columns.ts — where each stat lives in a box-score row.
 *
 * The engines write numbers into fixed slots; the viewer and the aggregator
 * read them back by the same names. One table per league, shared by both
 * sides of the worker boundary so neither can drift from the other.
 */

export const NBA = {
  SEC: 0,
  PTS: 1,
  FGM: 2,
  FGA: 3,
  TPM: 4,
  TPA: 5,
  FTM: 6,
  FTA: 7,
  OREB: 8,
  DREB: 9,
  AST: 10,
  STL: 11,
  BLK: 12,
  TOV: 13,
  PF: 14,
  PM: 15,
  START: 16,
  N: 17,
} as const;

export const NHL = {
  SEC: 0,
  G: 1,
  A: 2,
  SOG: 3,
  PIM: 4,
  PM: 5,
  PPP: 6,
  FOW: 7,
  FOL: 8,
  /** Goalies: shots against, goals against, decision (1 W, 2 L, 3 OTL). */
  SA: 9,
  GA: 10,
  DEC: 11,
  START: 12,
  N: 13,
} as const;

export const MLB = {
  PA: 0,
  AB: 1,
  R: 2,
  H: 3,
  D2: 4,
  D3: 5,
  HR: 6,
  RBI: 7,
  BB: 8,
  SO: 9,
  SB: 10,
  CS: 11,
  /** Batting-order slot, 1-9; 0 for anyone who did not start. */
  ORDER: 12,
  // pitching
  OUTS: 13,
  BF: 14,
  PH: 15,
  PR: 16,
  PER: 17,
  PBB: 18,
  PSO: 19,
  PHR: 20,
  NP: 21,
  /** Decision: 1 W, 2 L, 3 SV, 4 HLD. */
  DEC: 22,
  /** Order of appearance on the mound, 1 = starter; 0 = did not pitch. */
  APP: 23,
  N: 24,
} as const;

export const NFL = {
  CMP: 0,
  ATT: 1,
  PYD: 2,
  PTD: 3,
  INT: 4,
  SK: 5,
  SKY: 6,
  CAR: 7,
  RYD: 8,
  RTD: 9,
  RLNG: 10,
  TGT: 11,
  REC: 12,
  REYD: 13,
  RETD: 14,
  RELNG: 15,
  FUM: 16,
  FGM: 17,
  FGA: 18,
  XPM: 19,
  XPA: 20,
  FGLNG: 21,
  PUNT: 22,
  PNYD: 23,
  TKL: 24,
  DSK: 25,
  DINT: 26,
  /** Return and defensive touchdowns. */
  DTD: 27,
  TWOPT: 28,
  N: 29,
} as const;
