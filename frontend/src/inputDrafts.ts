import { useCallback, useContext, useRef, useState, type SetStateAction } from 'react';
import { SessionAccessContext, type InputDraft } from './sessionAccess';

/** Only explicit user input enters this memory cache; server reads initialize local state. */
export function useInputDraft<T>(key: string, initial: T) {
  const access = useContext(SessionAccessContext);
  const entry = useRef(access?.inputDrafts.get(key));
  const dirty = useRef(entry.current !== undefined);
  const [restored, setRestored] = useState(entry.current !== undefined);
  const [value, setValue] = useState<T>(() => entry.current ? entry.current.value as T : initial);
  const current = useRef(value);
  const live = useCallback(() => !access || access.active, [access]);

  const set = useCallback((action: SetStateAction<T>) => {
    if (!live()) return;
    const next = typeof action === 'function' ? (action as (previous: T) => T)(current.current) : action;
    current.current = next;
    const nextEntry: InputDraft = { value: next };
    entry.current = nextEntry; dirty.current = true;
    access?.inputDrafts.set(key, nextEntry);
    setValue(next);
  }, [access, key, live]);

  const clear = useCallback(() => {
    if (!live()) return;
    // An older editor must not erase input entered by a newer editor for this target.
    if (entry.current && access?.inputDrafts.get(key) === entry.current) access.inputDrafts.delete(key);
    entry.current = undefined; dirty.current = false; setRestored(false);
  }, [access, key, live]);

  const initialize = useCallback((next: T, replaceDirty = false) => {
    if (!live() || (dirty.current && !replaceDirty)) return;
    if (replaceDirty) clear();
    current.current = next;
    setValue(next);
  }, [clear, live]);

  return { value, set, restored, clear, initialize };
}
