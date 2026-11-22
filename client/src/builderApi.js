import { createContext, useContext } from 'react';
import { api } from './api.js';

/**
 * 14.3: where a builder (sermon, lesson, Bible study) reads and saves. Normally this Selah's own api. A sermon, lesson
 * or study shared with me to edit opens in its builder with sharedBuilderEnv: its calls go to the owner's Selah,
 * through mine and the share hub, and only these (each checked there against the shared note). Anything else a
 * builder might do (a series to file it in, slides, Preach, starting a sermon from a study…) isn't there: it throws,
 * and the builder hides those things when `shared` is set.
 */
export const BuilderEnv = createContext({ api, shared: null, coedit: null });
export const useBuilderEnv = () => useContext(BuilderEnv);
export const useBuilderApi = () => useContext(BuilderEnv).api;

const ALLOWED = ['getNote', 'makeSermon', 'writeSermon', 'updateSermon', 'lesson', 'writeLesson', 'makeBibleStudy', 'writeBibleStudy', 'updateBibleStudy'];

/** The builder's api for a note shared with me: { shareId, key, ownerName }. */
export function sharedBuilderEnv(shared) {
  const call = (method) => (...args) => api.sharedBuilder(shared.shareId, shared.key, method, args);
  const own = Object.fromEntries(ALLOWED.map((m) => [m, call(m)]));
  // Lists a builder only offers choices from (series, word studies): none here.
  Object.assign(own, { studies: async () => [], wordStudies: async () => [], noteMethod: async () => null });
  const sharedApi = new Proxy(own, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return async () => { throw new Error(`Only ${shared.ownerName || 'the owner'} can do that.`); };
    },
  });
  return {
    api: sharedApi,
    shared,
    coedit: { base: `/api/shared/${shared.shareId}/notes/${shared.key}/coedit`, id: `${shared.shareId}:${shared.key}` },
  };
}
