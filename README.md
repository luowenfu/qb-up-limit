# qb-up-limit

# 项目介绍

> 本项目由Ai制作，不评判任何运营商行为，仅供学习测试

**qB-达量限速管理**，带 Web，支持多设备，根据周期规则达到阈值后自动调整上传限速；可选集成 **Emby**，统计外网播放相关上行流量。

> 例每月上传达到 500GB 自动限速为 512KB/s，每月 1 日恢复至无限速

![image-20260624005902778](./assets/image-20260624005902778.png)

---

### Emby 集成（可选）：
**Emby 与 qB 设备视图合并展示**

![image-20260624010248383](./assets/image-20260624010248383.png)

**完整信息的播放会话记录+外网上行估算：**

![image-20260624012230492](./assets/image-20260624012230492.png)

---

**以及强大的图表统计功能，图略...**



## 快速开始（Docker Compose）

**Docker 部署**：

```bash
services:
  qb-up-limit:
    image: qb-up-limit:latest
    container_name: qb-up-limit
    restart: unless-stopped
    ports:
      - "8765:8765"
    environment:
      TZ: Asia/Shanghai
    volumes:
      # 运行时数据：配置、数据库、密钥、日志（首次启动自动创建）
      - ./data:/data
      # 可选：配置文件单独映射
      - ./config/config.yaml:/config/config.yaml:ro
      # 可选：Emby功能开启条件，必需采用docker运行（只读挂载 Docker Socket）
      - /var/run/docker.sock:/var/run/docker.sock:ro

```



### 访问

浏览器打开：`http://<主机IP>:8765`

**默认 Web 账号**（首次启动自动生成，请及时修改）：

| 用户名 | 密码 |
|--------|------|
| `admin` | `adminadmin` |

- `/data`：运行时配置、SQLite 数据库、加密密钥、日志
- `/config/config.yaml`：可选，仅**首次**无 `/data/config.yaml` 时导入
- Docker Socket：仅 Emby 容器流量统计需要；不需要 Emby 功能时可去掉该挂载



## 

## 安全提示（开源 / 部署前必读）

以下内容**切勿**提交到公开仓库或分享给他人：

- `data/config.yaml`（真实主机地址）
- `data/.qb_secrets`、`data/.emby_secrets`（API 密钥与密码）
- `data/.web_auth`、`data/.web_secret`、`data/.data_key`
- `data/*.db`、`data/app.log*`、`data/emby_events/`



## 许可证

[MIT](LICENSE)

## 致谢

- [qbittorrent-api](https://github.com/rmartin16/qbittorrent-api)
- [Flask](https://flask.palletsprojects.com/)
