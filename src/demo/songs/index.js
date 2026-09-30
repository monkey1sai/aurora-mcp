// Demo songs (multi-part, played by src/dsp/ensemble.js). Pure ES module (browser + Node).
// Each file default-exports one song definition (format: docs/SONGS.md). Resolve against the factory
// presets before playing:  resolveSong(def, PRESETS) from ../resolve.js → audio.songLoad(song).

import auroraDreams from './aurora-dreams.js';
import neonNights from './neon-nights.js';
import lofiRain from './lofi-rain.js';
import crystalCaves from './crystal-caves.js';
import pulseCity from './pulse-city.js';
import silkRoad from './silk-road.js';

/** All demo songs in display order. */
export const SONGS = Object.freeze([auroraDreams, neonNights, lofiRain, crystalCaves, pulseCity, silkRoad]);

/** Song definition by id (undefined if unknown). */
export function songById(id) {
  return SONGS.find(s => s.id === id);
}

export default SONGS;
