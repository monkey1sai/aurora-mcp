import { z } from 'zod';
import { PARAMS, SCALES } from '../src/dsp/params.js';
import { AXES } from '../src/creation/project.js';
const n = (min, max) => z.number().min(min).max(max);
const i = (min, max) => n(min, max).int();
const param = p => p.type === 'bool' ? z.boolean() : p.type === 'enum' ? z.enum(p.options) : p.type === 'int' ? i(p.min, p.max) : n(p.min, p.max);
export const Params = z.object(Object.fromEntries(PARAMS.map(p => [p.id, param(p).optional()]))).strict();
export const PatchParams = z.object(Object.fromEntries(PARAMS.filter(p => p.scope !== 'global').map(p => [p.id, param(p).optional()]))).strict();
export const GlobalParams = z.object(Object.fromEntries(PARAMS.filter(p => p.scope === 'global').map(p => [p.id, param(p).optional()]))).strict();
const Macro = z.object({ name: z.string().min(1).max(100), targets: z.array(z.object({ id: z.string(), amount: n(-1, 1) }).strict()).max(64) }).strict();
export const Patch = z.object({ name: z.string().max(100).optional(), category: z.string().max(100).nullable().optional(), params: PatchParams, macros: z.array(Macro).max(4) }).strict();
const axisShapes = {
  motive: z.object({ intervals: z.array(i(-24, 24)).min(1).max(32).optional(), durations: z.array(n(0.0625, 8)).min(1).max(32).optional(), development: z.enum(['repeat', 'transpose', 'invert', 'augment', 'fragment']).optional(), transpose: i(-12, 12).optional() }).strict(),
  rhythm: z.object({ bpm: n(40, 240).optional(), bars: i(1, 16).optional(), density: n(0, 1).optional(), rest: n(0, 1).optional(), swing: n(0, 0.6).optional(), tension: n(0, 1).optional() }).strict(),
  harmony: z.object({ root: i(0, 11).optional(), scale: z.enum(Object.keys(SCALES).filter(k => k !== 'off')).optional(), octave: i(1, 7).optional(), progression: z.array(i(0, 6)).min(1).max(16).optional(), atonal: z.boolean().optional() }).strict(),
  expression: z.object({ start: n(0, 1).optional(), end: n(0, 1).optional(), articulation: n(0.05, 1).optional(), humanize: n(0, 1).optional() }).strict(),
  timbre: z.object({ preset: z.string().min(1).max(100).optional(), brightness: n(0, 1).optional(), attack: n(0.001, 5).optional(), release: n(0.01, 8).optional(), space: n(0, 1).optional(), width: n(0, 1).optional() }).strict(),
};
export const Axes = z.object(Object.fromEntries(Object.entries(axisShapes).map(([k, v]) => [k, v.optional()]))).strict();
const beat = n(0, 720), value = z.union([z.boolean(), z.number(), z.string()]);
export const Event = z.discriminatedUnion('type', [
  z.object({ beat, type: z.literal('on'), note: i(0, 127), vel: n(0.01, 1), dur: n(0.001, 720) }).strict(),
  z.object({ beat, type: z.literal('param'), id: z.string(), value }).strict(),
  z.object({ beat, type: z.literal('params'), values: PatchParams }).strict(),
  z.object({ beat, type: z.literal('macro'), index: i(0, 3), value: n(0, 1) }).strict(),
  z.object({ beat, type: z.literal('ramp-macro'), index: i(0, 3), to: n(0, 1), beats: n(0, 720) }).strict(),
  z.object({ beat, type: z.literal('ramp'), id: z.string(), to: z.number(), beats: n(0, 720) }).strict(),
  z.object({ beat, type: z.literal('ctrl'), kind: z.enum(['wheel', 'aftertouch', 'bend']), value: n(-1, 1) }).strict(),
]);
export const Track = z.object({ name: z.string().min(1).max(100), role: z.string().min(1).max(100), patch: Patch, gain: n(-60, 6), pan: n(-1, 1), mute: z.boolean(), events: z.array(Event).max(8192) }).strict();
export const Project = z.object({ version: z.literal('1.0.0'), title: z.string().min(1).max(100), kind: z.enum(['music', 'sound', 'sfx']), seed: i(1, 4294967295), axes: Axes, globals: GlobalParams, lengthBeats: n(0.05, 720), tracks: z.array(Track).min(1).max(8), revision: i(0, 1000000), provenance: z.object({ engine: z.string(), source: z.string() }).strict().optional() }).strict();
export const RenderOptions = z.object({ sampleRate: z.union([z.literal(16000), z.literal(24000), z.literal(44100), z.literal(48000)]).optional(), tailSeconds: n(0, 8).optional(), bitDepth: z.union([z.literal(16), z.literal(24)]).optional(), loop: z.boolean().optional(), fadeSeconds: n(0, 0.2).optional() }).strict();
export const Create = z.object({ title: z.string().min(1).max(100).optional(), kind: z.enum(['music', 'sound', 'sfx']).optional(), seed: i(1, 4294967295).optional(), axes: Axes.optional(), patch: Patch.optional() }).strict();
export const ProjectInput = z.object({ project: Project }).strict();
export const Index = i(0, 7).default(0);
export const Output = z.object({ status: z.string(), data: z.record(z.string(), z.unknown()) }).strict();
export const axisDescriptions = AXES;
