import {useEffect, useMemo, useSyncExternalStore} from 'react';
import {EdgezMeshSession, type EdgezMeshSessionOptions, type EdgezMeshState} from './EdgezMeshSession';

export function useEdgezMesh(session: EdgezMeshSession): EdgezMeshState {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}

export function useEdgezMeshSession(options: EdgezMeshSessionOptions = {}): [EdgezMeshSession, EdgezMeshState] {
  const session = useMemo(() => new EdgezMeshSession(options), []); // Options are constructor callbacks by design.
  useEffect(() => () => session.dispose(), [session]);
  return [session, useEdgezMesh(session)];
}
