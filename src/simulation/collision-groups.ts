// Supply cannot collide with the rear cabinet wall it extends behind.
export const MACHINE_GROUPS = (1 << 16) | 2;
export const BOARD_COIN_GROUPS = (2 << 16) | 31;
export const STOCK_COIN_GROUPS = (4 << 16) | 14;
export const FEED_TRAY_GROUPS = (8 << 16) | 6;
// Rails support stock normally; redundant floor contacts snag on escapement seams.
export const FEED_FLOOR_GROUPS = (16 << 16) | 2;
