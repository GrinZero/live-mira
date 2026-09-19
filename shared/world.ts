export interface WorldLocation {
  id: string;
  key: string;
  name: string;
  description: string;
  url: string;
  fgUrl?: string;
  firstVisitedAt: number;
  lastVisitedAt: number;
  visits: number;
  x: number;
  y: number;
  mapUrl?: string;
  mapStatus: 'pending' | 'ready' | 'failed';
  environment: { rain: number; dim: number };
}

export interface WorldView {
  id: string;
  revision: number;
  currentLocationId: string;
  sceneInstanceId: string;
  locations: WorldLocation[];
  connections: { from: string; to: string }[];
  travel?: { id: string; targetId: string; status: 'preparing' | 'ready' };
}

export interface WorldObject {
  id: string;
  kind: 'photo' | 'cup' | 'phone';
  url?: string;
  caption?: string;
  owner: { kind: 'location'; locationId: string; anchor: string } | { kind: 'character'; hand: 'left' | 'right' };
}
