// Chain-agnostic feed + adapter contracts. Each adapter owns its chain's
// discovery / read / publish; index.ts orchestrates over a flat feed list.

export interface Feed {
  key: string; // unique across adapters — state + threshold map key
  label: string; // for logs
}

export interface ChainAdapter {
  name: string;
  loadFeeds(): Promise<Feed[]>;
  read(feed: Feed): Promise<bigint>;
  send(feed: Feed): Promise<string>;
}
