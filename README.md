# qb-up-limit

# 项目介绍

**qB-达量限速管理**

> 例：qb 每月上传达到 500GB 自动限速为 512KB/s，每月 1 日自动恢复至无限速

![image-20260624005902778](./assets/image-20260624005902778.png)

---

### Emby 功能（可选）：
**Emby 与 qB 设备视图合并展示**

![image-20260624010248383](./assets/image-20260624010248383.png)

**完整信息的播放会话记录+外网上行估算：**

![image-20260624012230492](./assets/image-20260624012230492.png)

---

**以及强大的图表统计功能，图略...**

## 下版本计划
1、优化Emby的【估算上行】的算法，提高准确率，如果有更好的思路算法，欢迎提交提议。

2、Emby功能将增加达量规则，限制超量上传的用户播放，从而实现 QB+Emby 双功能的流量监控与达量限制...


## 快速开始（Docker Compose）

**Docker 部署**：

```bash
services:
  qb-up-limit:
    image: luowenfu/qb-up-limit:latest
    container_name: qb-up-limit
    restart: unless-stopped
    network_mode: host
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

## 

## 安全提示（开源 / 部署前必读）

以下内容**切勿**提交到公开仓库或分享给他人：

- `data/config.yaml`（真实主机地址）
- `data/.qb_secrets`、`data/.emby_secrets`（API 密钥与密码）
- `data/.web_auth`、`data/.web_secret`、`data/.data_key`
- `data/*.db`、`data/app.log*`、`data/emby_events/`

> 仅供学习测试

## 许可证

[MIT](LICENSE)

## 致谢

- [qbittorrent-api](https://github.com/rmartin16/qbittorrent-api)
- [Flask](https://flask.palletsprojects.com/)
