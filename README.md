# FFast Share

FFast Share 是一个使用 Node.js 构建的自托管文件分享服务。登录后可在整个页面拖放文件，上传完成后复制分享链接；接收方无需登录即可用浏览器、`curl` 或 `wget` 下载。

## 功能

- 整页拖拽上传，释放后立即开始；支持多文件队列、进度查看、取消和失败重试。
- 文件库支持搜索、复制分享链接和删除。删除文件后对应链接立即失效。
- 首次访问时设置单个全局访问密码；使用 HttpOnly 会话 Cookie 和登录限速保护管理界面。
- 文件默认最大 2 GiB。分享链接持续有效，直到管理员删除文件。
- SQLite、上传文件和临时文件保存在持久化数据目录。

## Docker Compose 部署

需要安装 Docker Engine 和 Docker Compose 插件。在部署目录中运行：

```sh
cp .env.example .env
```

编辑 `.env`，把地址改成用户实际访问的公开地址。例如：

```dotenv
PUBLIC_BASE_URL=https://share.example.com
COOKIE_SECURE=true
MAX_UPLOAD_SIZE_BYTES=2147483648
```

通过 HTTPS 反向代理提供服务时，必须使用公开的 HTTPS 地址并启用安全 Cookie。之后拉取镜像并启动：

```sh
docker compose pull
docker compose up -d
```

默认使用 Docker Hub 上的 `nafnix/ffast:latest`。如需固定到某个发布版本，可在 `.env` 中设置 `IMAGE_TAG=1.2.3`，再运行 `docker compose pull` 和 `docker compose up -d`。

默认情况下，Compose 将应用端口仅绑定到本机 `127.0.0.1:3000`，并使用名为 `ffast-data` 的 Docker 卷保存密码配置、文件列表和文件内容。浏览器首次访问 `PUBLIC_BASE_URL` 时会显示密码初始化页面。

该端口默认供同机反向代理访问。如果不使用同机反向代理，可将 `compose.yaml` 中的端口映射改为 `3000:3000`，并确保防火墙、公开地址及 HTTPS Cookie 配置符合你的部署方式。

查看运行状态和日志：

```sh
docker compose ps
docker compose logs -f app
```

停止服务但保留数据：

```sh
docker compose down
```

不要使用 `docker compose down -v`，该命令会删除持久化卷及其中的文件。

## GitHub Actions 与 Docker Hub 发布

首次发布前，在 Docker Hub 创建公开仓库 `nafnix/ffast`，并创建一个有写入权限的访问令牌。然后在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中添加：

- `DOCKERHUB_USERNAME`：Docker Hub 用户名。
- `DOCKERHUB_TOKEN`：Docker Hub 访问令牌。

GitHub Actions 会在 Pull Request 和分支推送时运行依赖安装、测试和生产构建。检查通过后，默认分支推送会发布 `latest` 和 `sha-<短提交号>`；推送 `v1.2.3` 这样的版本标签会发布 `1.2.3`、`1.2` 和 `1`。`latest` 只跟随默认分支。Pull Request 和非默认分支不会发布镜像。

项目使用 bumpp 管理版本发布，以 `package.json` 的 `version` 为版本来源。建议使用与 CI 一致的 Node.js 24（24.11 或更新版本）和 pnpm 11。先提交所有待发布的修改，确保工作区干净，再切换到 `master` 并同步远端：

```sh
git switch master
git pull --ff-only
pnpm install --frozen-lockfile
pnpm release
```

在交互提示中选择 `patch`（修订版本）、`minor`（次版本）或 `major`（主版本），确认后会自动更新 `package.json`、创建 `chore: release vX.Y.Z` 提交、创建 `vX.Y.Z` Git 标签，并推送当前分支和版本标签。取消确认不会修改版本或创建提交、标签。

例如，当前版本为 `1.0.0` 时选择 `patch`，会升级到 `1.0.1` 并推送 `v1.0.1`，触发 GitHub Actions 发布 `nafnix/ffast:1.0.1`、`nafnix/ffast:1.0` 和 `nafnix/ffast:1`；`master` 上的版本提交同时触发 `latest` 和 SHA 标签发布。等待 Actions 成功后，可在部署目录的 `.env` 中设置 `IMAGE_TAG=1.0.1`，再运行 `docker compose pull` 和 `docker compose up -d`。

发布时请选择正式版本 `X.Y.Z`。当前 CI 仅接受 `vX.Y.Z` 格式，`beta`、`rc` 等预发布标签会被拒绝。

## 反向代理

反向代理需要允许至少与应用上传上限相同的请求体大小，并将上传和下载超时设置为适合大文件传输的时长。下面是 Nginx 示例，可放入站点的 `server` 配置中：

```nginx
client_max_body_size 2g;
client_body_timeout 1h;

location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

反向代理上限、超时和 `MAX_UPLOAD_SIZE_BYTES` 应保持一致。大文件上传需要足够的临时磁盘空间，反向代理关闭请求缓冲后，上传内容会直接流向应用。

## 直接下载

从文件列表复制分享链接后，可以在另一台 Linux 服务器上使用：

```sh
curl -fL -OJ 'https://share.example.com/download/分享令牌'
wget --content-disposition 'https://share.example.com/download/分享令牌'
```

下载链接本身就是访问凭证，请只分享给预期接收者。删除文件后链接立即失效。

## 修改密码

在应用容器内运行密码重设向导。新密码不会回显到终端，重设后现有会话会全部退出：

```sh
docker compose exec -it app pnpm reset-password
```

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | 分享链接和来源校验使用的公开根地址 |
| `COOKIE_SECURE` | `false` | HTTPS 部署时设为 `true` |
| `MAX_UPLOAD_SIZE_BYTES` | `2147483648` | 单文件最大字节数，默认 2 GiB |
| `DATA_DIR` | 应用目录下的 `data` | SQLite 和文件数据目录；Compose 中固定为 `/data` |

## 本地开发

需要 Node.js 22 或更新版本及 pnpm 11：

```sh
pnpm install
pnpm dev
```

访问 `http://localhost:3000`，按页面提示设置密码。默认本地数据目录为项目目录下的 `data/`。

## 测试和构建

```sh
pnpm test          # 运行单元和接口测试
pnpm test:watch    # 监听文件变化并运行测试
pnpm build         # 构建 Next.js 生产版本
```

测试使用系统临时目录中的独立 SQLite 数据库，测试完成后会清理，不会修改开发或部署数据。
