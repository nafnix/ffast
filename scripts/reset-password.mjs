import Database from "better-sqlite3";
import { randomBytes, scrypt } from "node:crypto";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import readline from "node:readline";

const scryptAsync = promisify(scrypt);
const dataDirectory = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const databasePath = join(dataDirectory, "ffast.sqlite");

if (!existsSync(databasePath)) {
  console.error(`找不到数据库：${databasePath}`);
  console.error("请先启动并初始化 FFast Share，再运行密码重设命令。");
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error("密码重设需要交互式终端，请使用 docker compose exec -it app pnpm reset-password。");
  process.exit(1);
}

function readSecret(prompt) {
  return new Promise((resolveSecret, rejectSecret) => {
    const input = process.stdin;
    const characters = [];
    let finished = false;
    process.stdout.write(prompt);
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    const finish = (error) => {
      if (finished) return;
      finished = true;
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) rejectSecret(error);
      else resolveSecret(characters.join(""));
    };

    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === "c") {
        finish(new Error("操作已取消。"));
      } else if (key.name === "return" || key.name === "enter") {
        finish();
      } else if (key.name === "backspace") {
        characters.pop();
      } else if (!key.ctrl && !key.meta && character) {
        characters.push(character);
      }
    };

    input.on("keypress", onKeypress);
  });
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return ["scrypt", 1 << 15, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
}

let database;
try {
  const password = await readSecret("输入新的访问密码（至少 4 个字符）：");
  if (password.length < 4 || password.length > 1024) throw new Error("密码长度需为 4 到 1024 个字符。");
  const confirmation = await readSecret("再次输入新密码：");
  if (password !== confirmation) throw new Error("两次输入的密码不一致。");

  const passwordHash = await hashPassword(password);
  database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.transaction(() => {
    const update = database.prepare("UPDATE settings SET value = ? WHERE key = ?").run(passwordHash, "admin_password_hash");
    if (update.changes !== 1) throw new Error("数据库中没有已初始化的访问密码，请先完成网页初始化。");
    database.prepare("DELETE FROM sessions").run();
    database.prepare("DELETE FROM login_limits").run();
  })();
  console.log("访问密码已重设，所有现有会话已退出。\n");
} catch (error) {
  console.error(error instanceof Error ? error.message : "密码重设失败。");
  process.exitCode = 1;
} finally {
  database?.close();
}
