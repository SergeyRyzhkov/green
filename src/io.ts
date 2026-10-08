import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const readJson = async <T>(file: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
};

export const writeJson = async (
  file: string,
  value: unknown,
): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

export const backup = async (file: string): Promise<void> => {
  try {
    await copyFile(file, `${file}.bak`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
      throw error;
    }
  }
};
