import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

export const chromiumAvailable = existsSync(chromium.executablePath());
export const chromiumMissingReason = 'Chromium absent: run bunx playwright install chromium';
