"use client";

import { useState } from "react";
import type { FormEvent } from "react";

type AuthFormProps = { mode: "setup" | "login"; initialMessage?: string };

export function AuthForm({ mode, initialMessage }: AuthFormProps) {
  const isSetup = mode === "setup";
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState(initialMessage ?? "");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    if (isSetup && password !== confirmation) {
      setMessage("两次输入的密码不一致。");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(isSetup ? "/api/setup" : "/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, ...(isSetup ? { confirmation } : {}) }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(result.error || "操作失败，请稍后重试。");
        return;
      }
      window.location.assign("/files");
    } catch {
      setMessage("无法连接到服务，请检查网络后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <BrandMark />
        <div className="auth-intro">
          <span className="eyebrow">FFAST SHARE</span>
          <h1 id="auth-title">{isSetup ? "欢迎使用 FFast" : "欢迎回来"}</h1>
          <p>{isSetup ? "先设置一个访问密码，保护你的文件分享空间。" : "输入访问密码，继续管理你的文件。"}</p>
        </div>
        <form
          action={isSetup ? "/api/setup" : undefined}
          className="auth-form"
          method={isSetup ? "post" : undefined}
          onSubmit={submit}
        >
          <label className="field-label" htmlFor="password">访问密码</label>
          <input
            autoComplete={isSetup ? "new-password" : "current-password"}
            autoFocus
            id="password"
            maxLength={1024}
            minLength={isSetup ? 4 : undefined}
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder={isSetup ? "至少 4 个字符" : "输入你的密码"}
            required
            type="password"
            value={password}
          />
          {isSetup && (
            <>
              <label className="field-label" htmlFor="confirm-password">再次输入密码</label>
              <input
                autoComplete="new-password"
                id="confirm-password"
                maxLength={1024}
                minLength={4}
                name="confirmation"
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder="确认你的访问密码"
                required
                type="password"
                value={confirmation}
              />
              <p className="field-note">密码至少 4 个字符。请妥善保存，忘记后可在服务器上重设。</p>
            </>
          )}
          {message && <p className="form-error" role="alert">{message}</p>}
          <button className="auth-submit" disabled={submitting} type="submit">
            {submitting ? "请稍候…" : isSetup ? "设置密码并继续" : "登录"}
            <ArrowIcon />
          </button>
        </form>
        <div className="auth-footnote"><LockIcon /> 私有部署 · 分享链接仅对持有链接的人开放</div>
      </section>
      <p className="auth-caption">让文件分享，简单一点。</p>
    </main>
  );
}

function BrandMark() {
  return (
    <div className="brand-lockup">
      <span className="brand-symbol"><CloudIcon /></span>
      <span>FFast<span className="brand-light"> Share</span></span>
    </div>
  );
}

function CloudIcon() {
  return <svg aria-hidden="true" viewBox="0 0 32 32" fill="none"><path d="M9.2 23.8h14.1a5.6 5.6 0 0 0 .6-11.2 8.3 8.3 0 0 0-15.8 2.1 4.6 4.6 0 0 0 1.1 9.1Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.1"/><path d="M16 21v-7m0 0-2.7 2.7M16 14l2.7 2.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"/></svg>;
}

function ArrowIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="M4 10h11m0 0-4.2-4.2M15 10l-4.2 4.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7"/></svg>;
}

function LockIcon() {
  return <svg aria-hidden="true" viewBox="0 0 18 18" fill="none"><rect x="3.7" y="7.4" width="10.6" height="8" rx="2" stroke="currentColor" strokeWidth="1.4"/><path d="M6.2 7.3V5.6a2.8 2.8 0 0 1 5.6 0v1.7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4"/></svg>;
}
