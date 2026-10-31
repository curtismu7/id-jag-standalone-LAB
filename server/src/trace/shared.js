// One trace sink per workspace, created on first use. No route reads it yet.
import { currentWorkspace } from '../workspace.js';
import { createSink } from './sink.js';

const sinks = new Map();

export function traceSinkFor(id = currentWorkspace()) {
  if (!sinks.has(id)) sinks.set(id, createSink());
  return sinks.get(id);
}
