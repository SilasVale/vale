# ADR 0009 — 自包含安装包（pinned tgz 内嵌）

- 状态：Accepted（2026-09-09，随 1.2.307 installer 重打生效）
- 背景：在线包运行时才下载 pinned tgz，带来两个必现失败：
  1. 老安装包 + 被 last-5-per-minor prune 掉的 tgz = 安装到一半 404
    （"版本钉死可复现"是假的）；
  2. 每个新用户都是强制两段式（Setup 装旧版 → 立刻 `vale update`）。

## 决定

makensis 把已 stage 的 `vale-agent-<ver>.tgz` 用 `File` 打进安装包；
引导脚本优先用 `-LocalTgz` 装（CDN 下载保留为手动跑脚本时的回退）；
装完即删内嵌包（~6MB 死重不留；失败残留由重跑覆盖、卸载整目录删）。

## 证明（结构性的，不是文档约定）

- 构建 FAIL-CLOSED：成品 exe 必须 **大于** 内嵌 tgz（stub + lzma 开销），
  否则说明 payload 没打进去（在线包时代的 150KB 门同时作废）。
- 发布 WARN：staged 安装器不比 tgz 大 = 陈旧在线包残留，提醒重打。
- `installer_sha256`（已在 version.json + smoke 里）现在覆盖整个 exe，
  等价于覆盖了内嵌 tgz —— 篡改安装包 = 篡改 manifest，可验证。

## 代价（接受）

- 安装包 150KB → ~6.7MB（CDN 流量 + 用户下载时间；仍远小于 Electron
  那 ~100MB）。
- 失败安装会在 scripts\ 留一个 6MB tgz（重跑覆盖；卸载删干净）。

## 签名（SmartScreen）

- 自包含解决"篡改可验证"（installer_sha256 覆盖整个 exe），不解决
  "系统认识"——无 Authenticode 证书，首次运行照样蓝屏警告，用户点
  "更多信息 → 仍要运行"，或对哈希自证。
- 根治 = 买公网 CA 证书：OV（~$100–300/年，公司实名，靠下载量攒
  reputation，初期仍可能弹）或 EV（~$300–500/年+硬件 token，即时信任）。
- 流水线已就绪：`build-installer.sh sign_exe`（osslsigncode userspace，
  `-h sha256`，可选 TSA；无证书自动跳过，构建照常可发），自签名证书
  全链路验证过（sign → verify ok，+1471B）。买完设
  `VALE_SIGN_CRT`/`VALE_SIGN_KEY`（+可选 `VALE_SIGN_PASS`/`VALE_SIGN_TSA`）
  即插即用——证书和密码永不进仓库、不进日志。

## 顺序约束

tgz 必须先 pack+stage，安装器才能打（build 打包时 File 不存在就地失败，
不出半吊子包）。`publish-release.sh --with-installer` 把顺序编进来：
pack → stage tgz → build-installer.sh --no-deploy → manifest → 单次 deploy。
