// Opt-in registration of pbe-weather-maxtemp-intraday@2.2.0 (SHADOW). Import this module (the shadow lane, research
// scripts, tests) to enable forecastIntraday(..., { tempModelVersion: '2.2.0' }). The production v2.1 path never imports
// it, so the 2.8 MB SHADOW artifact stays out of that bundle.
import art from '../artifacts/temp-intraday-v2.2.json' with { type: 'json' };
import { registerIntradayTempArtifact } from './engine.js';

export const TEMP_V22_MODEL = registerIntradayTempArtifact(art);
export const TEMP_V22_ARTIFACT = art;
