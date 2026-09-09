# Vale Windows 在线安装包 — 测试清单

安装包：`https://agent.saisi.online/vale-agent/ValeAgent-Setup.exe`
（版本钉死，当前 1.2.306；按版本另有 `ValeAgent-Setup-<ver>.exe`。）

**只能在备用 Windows 沙盒机上测，不要在生产设备（d1）上跑**——安装会停
agent、重装同版本并重启桌面壳，中断正在跑的 AI 会话。

## 安装测试（全新机器最佳）

1. 右键 → 以管理员身份运行 `ValeAgent-Setup.exe`。
2. 向导页：欢迎（品牌图）→ 目录（默认 `C:\Program Files\Vale`）→
   安装进度 → 完成页。
3. 进度页应依次出现：Node（复用或下载便携版）→ `npm i -g` →
   `vale setup` → Electron（约 100MB）→ 任务/快捷方式 → DONE。
4. 完成后核对：
   - `vale --version` / 面板 `http://127.0.0.1:18080/desktop/` 可开
   - 任务计划 `ValeAgent`（SYSTEM）+ `ValeDesktop`（登录）存在
   - 注册表 `HKLM\SOFTWARE\Vale\Agent\InstallDir`
   - 桌面 `Vale.lnk` 图标是日出标（非空白）
   - 托盘 + 任务栏窗口图标正常，`D:\Vale` 类比目录无报错
   - `install-result.txt` 四行回执无 WARNING（Electron 未装上算 WARNING，
     可接受：agent 本体不受影响）
5. 登记设备（安装器不再询问注册码）：装完后在设备面板 设置 → Gateway
   卡片填 网关地址 + 注册码（控制台 → 设备管理 → 生成注册码）一键登记；
   或重装前手动跑 `vale setup --reg-key <码>`。

## 卸载测试

控制面板 → 卸载 Vale Agent：任务/程序目录/注册表/快捷方式应清除，
`%ProgramData%\Vale` 数据默认保留（`vale uninstall --purge-data` 才删）。

## 回报格式

版本 + 机器（全新/覆盖）+ 上面 4/5 逐项 OK/FAIL + `installer.log`
（安装目录下）相关段落。
