import { BUILDING_DEFS, UNIT_DEFS } from './constants';
import type { GameCommand } from './protocol';

/** Validate untrusted JSON before the authoritative simulation sees it. */
export function isGameCommand(value: unknown, mapSize: number): value is GameCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  const id = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  const ids = (v: unknown) => Array.isArray(v) && v.length > 0 && v.length <= 200 && v.every(id) && new Set(v).size === v.length;
  const coordinate = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < mapSize;
  const point = coordinate(c.x) && coordinate(c.y);
  const queue = c.queue === undefined || typeof c.queue === 'boolean';
  switch (c.kind) {
    case 'move': return ids(c.unitIds) && point && queue;
    case 'stop': return ids(c.unitIds);
    case 'delete': return ids(c.ids);
    case 'repair': case 'garrison': case 'gather': case 'attack': return ids(c.unitIds) && id(c.targetId);
    case 'unload': return id(c.buildingId);
    case 'build': return ids(c.unitIds) && typeof c.building === 'string' && Object.hasOwn(BUILDING_DEFS, c.building) && coordinate(c.tileX) && coordinate(c.tileY) && Number.isInteger(c.tileX) && Number.isInteger(c.tileY) && queue;
    case 'train': return id(c.buildingId) && typeof c.unit === 'string' && Object.hasOwn(UNIT_DEFS, c.unit);
    case 'cancelTrain': return id(c.buildingId) && typeof c.index === 'number' && Number.isInteger(c.index) && c.index >= 0 && c.index < 100;
    case 'setRally': return id(c.buildingId) && point;
    case 'advanceAge': return true;
    case 'research': return id(c.buildingId) && typeof c.techId === 'string' && c.techId.length > 0 && c.techId.length < 100;
    case 'trade': return (c.action === 'buy' || c.action === 'sell') && ['food', 'wood', 'stone'].includes(String(c.resource));
    default: return false;
  }
}
