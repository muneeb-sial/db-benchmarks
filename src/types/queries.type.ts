export interface Names {
  users: string;
  posts: string;
  likes: string;
  documents: string;
}

export interface Built {
  sql: string;
  params: unknown[];
}

export interface IndexDdl {
  name: string;
  create: string;
  drop: string;
}
