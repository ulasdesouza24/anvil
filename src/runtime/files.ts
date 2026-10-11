import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FilesConfig } from "../core/config.js";
import { extractContent, type FileContent } from "../core/fileExtract.js";

/** An attached file (docs/FILES.md): the original bytes, and the content that agents read. */
export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: number;
  content: FileContent;
}

/** The value of a file in an agent input or a file node: its metadata and its content. */
export interface FileValue extends FileContent {
  fileId: string;
  name: string;
  mime: string;
  size: number;
}

export interface FileServiceLike {
  get(id: string): StoredFile | undefined;
  value(id: string): FileValue | undefined;
}

const ID = /^f_[a-z0-9]{8,24}$/;

/** Files live in <dataDir>/files/<id>/: the original file and meta.json with the content. */
export class FileService implements FileServiceLike {
  private dir: string;
  private cache = new Map<string, StoredFile>();
  constructor(
    dataDir: string,
    private cfg: FilesConfig,
  ) {
    this.dir = path.join(dataDir, "files");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  async save(name: string, mime: string, bytes: Buffer): Promise<StoredFile> {
    if (bytes.length > this.cfg.maxBytes) throw new Error(`"${name}" is ${Math.round(bytes.length / 1048576)} MB. The limit is ${Math.round(this.cfg.maxBytes / 1048576)} MB (ANVIL_FILE_MAX_BYTES).`);
    const clean = path.basename(name).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
    const id = `f_${crypto.randomBytes(8).toString("hex")}`;
    const content = await extractContent(clean, mime, bytes, this.cfg);
    const file: StoredFile = { id, name: clean, mime: mime || "application/octet-stream", size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), createdAt: Date.now(), content };
    const d = path.join(this.dir, id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "original"), bytes);
    fs.writeFileSync(path.join(d, "meta.json"), JSON.stringify(file));
    this.cache.set(id, file);
    return file;
  }

  get(id: string): StoredFile | undefined {
    if (!ID.test(id)) return undefined;
    const hit = this.cache.get(id);
    if (hit) return hit;
    const p = path.join(this.dir, id, "meta.json");
    if (!fs.existsSync(p)) return undefined;
    const file = JSON.parse(fs.readFileSync(p, "utf8")) as StoredFile;
    this.cache.set(id, file);
    return file;
  }

  value(id: string): FileValue | undefined {
    const f = this.get(id);
    return f ? { fileId: f.id, name: f.name, mime: f.mime, size: f.size, ...f.content } : undefined;
  }

  bytes(id: string): Buffer | undefined {
    if (!this.get(id)) return undefined;
    return fs.readFileSync(path.join(this.dir, id, "original"));
  }

  delete(id: string): boolean {
    if (!this.get(id)) return false;
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    this.cache.delete(id);
    return true;
  }
}
