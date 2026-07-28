import fs from "node:fs";
import path from "node:path";

export class GoSaveStore {
  constructor(directory) {
    this.directory = directory;
    this.filePath = path.join(directory, "go-current.json");
  }

  load() {
    if (!fs.existsSync(this.filePath)) return null;
    return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
  }

  save(payload) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporaryPath = path.join(this.directory, `go-current.${process.pid}.tmp`);
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
    return { filePath: this.filePath, savedAt: payload.savedAt };
  }
}
