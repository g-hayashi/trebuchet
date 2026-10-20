/** アプリの版 = マイグレーションの適用数（R8） */
export type AppVersion = { registry: number; tenant: number };

export type ManifestFile = { path: string; size: number; sha256: string };

export type ManifestEntity = {
  id: string;
  name: string;
  fiscalYears: { year: number; journals: number }[];
};

export type BackupManifest = { files: ManifestFile[]; entities: ManifestEntity[] };

export type SnapshotFile = { path: string; bytes: Buffer };

/** snapshotDataDir の結果。files は平文の SQLite の写し（暗号化の前の段階） */
export type Snapshot = { files: SnapshotFile[]; manifest: BackupManifest };

export type UnpackedArchive = { manifest: BackupManifest; files: SnapshotFile[] };
