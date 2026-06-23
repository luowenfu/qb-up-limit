# 自写 Emby JSON 日志 + 获取信息 — 方案方法总结

本文档记录当前代码中**已落地**的「自写 Emby 播放记录日志卡片」完整实现方案，供后续维护与扩展参考。

---

## 1. 背景与目标

### 1.1 为何不用 Emby 活动日志作为主数据源

Emby 自带的 `/System/ActivityLog/Entries`（活动日志）存在以下局限：

- 开始/停止/暂停等事件分散，需前端或后端做复杂的 start/stop 配对合并
- 高版本与低版本字段不一致（有无 `ItemId`、Overview 格式差异）
- 无法稳定获得**单次播放段**的观看起止位置、实际播放时长、跳转次数
- 无法与 Docker 容器实测流量做**按会话分摊**的外网上行估算

### 1.2 当前方案核心思路

| 维度 | 方案 |
|------|------|
| 真相源 | Emby `/Sessions` API 轮询（采集调度每 `refresh_interval` 秒轻量探测） |
| 持久化 | 每实例一个 JSON 文件，热更新 `records[]` 播放段列表 |
| 观看进度 | 内存 tracker 按 tick 累计，结束时冻结写入 JSON |
| 外网上行 | Docker 实测增量 → 外网会话码率分摊累加器 → 段结束时 take 写入 |
| 前端展示 | 一段一卡，复用活动日志卡片的徽章/观看/上行 UI 组件 |
| 用户上行图表 | ended 外网段入库 SQLite `emby_playback_upload_facts` |

界面上「新版日志」= 自写 JSON 播放记录；「原始日志」= 仍走活动日志 API（只读对照）。

---

## 2. 总体架构

```
EmbyMonitor (emby_scheduler.py)
    │
    ├─ 每 tick 拉取 /Sessions
    │       └─ playback_record_store.tick_from_sessions()  →  JSON 热更新
    │       └─ enrich_sessions_playback_started_at()       →  实时会话附加 started_at
    │
    ├─ 完整采集周期：Docker stats → 外网过滤 → save_snapshot
    │       └─ emby_playback_traffic.accumulate_wan_upload()  →  内存累加器
    │
    └─ live_cache → Web API → 前端 emby.js 渲染卡片

段结束 (ended / incomplete)
    ├─ emby_watch_progress 冻结观看字段
    ├─ emby_playback_upload_sync.resolve_upload_bytes()  →  estimated_upload_bytes
    └─ emby_traffic_db.save_playback_upload_fact()       →  SQLite（仅外网 ended）
```

**涉及主要模块：**

| 文件 | 职责 |
|------|------|
| `app/playback_record_store.py` | JSON 读写、段生命周期、tick 入口 |
| `app/emby_watch_progress.py` | 观看进度 tracker（起止位置、时长、跳转） |
| `app/emby_scheduler.py` | 采集调度，串联 Sessions + 流量 + 播放记录 |
| `app/emby_client.py` | Sessions 规范化、媒体元数据提取 |
| `app/emby_traffic_filter.py` | 外网判断、码率分摊、累加器 key |
| `app/emby_playback_traffic.py` | 外网上行内存累加器 |
| `app/emby_playback_upload_sync.py` | 段结束时解析并写入估算上行 |
| `app/emby_upload_estimate.py` | 公式兜底与封顶 |
| `app/emby_traffic_db.py` | 用户上行事实表与聚合统计 |
| `app/emby_storage_paths.py` | JSON 路径规则 |
| `app/web/server.py` | REST API |
| `app/web/static/js/emby.js` | 播放记录卡片渲染 |

---

## 3. JSON 存储设计

### 3.1 路径规则

- 目录：`/data/emby_events/`
- 文件名：`{安全实例名}_{sha256前12位}.json`（见 `emby_storage_paths.safe_filename`）
- 示例：`data/emby_events/Emby示例_a1b2c3d4e5f6.json`

### 3.2 文件结构

```json
{
  "instance_name": "Emby示例",
  "next_id": 17,
  "records": [ /* 最多 500 条，见 MAX_STORED_RECORDS */ ]
}
```

### 3.3 单条 record 字段说明

| 字段 | 说明 |
|------|------|
| `id` | 自增段 ID |
| `status` | `playing` / `ended` / `incomplete` |
| `source` | 固定 `native`（Sessions 自写） |
| `emby_session_id` | Emby 会话 ID |
| `started_at` / `stopped_at` | UTC ISO 时间（`...0000Z`） |
| `last_tick_at` | 最后一次 Sessions tick 时间 |
| `interrupt_reason` | 如 `timeout_offline`（API 离线超 30 分钟） |
| `user_id` / `user_name` / `client` / `device_name` | 用户与客户端 |
| `remote_endpoint` / `client_ip` / `is_remote` | 网络与外网标记 |
| `item_id` / `item_type` / `item_title` / `series_name` / `episode_label` / `production_year` | 媒体信息 |
| `play_method` / `transcode_kind` / `is_video_direct` / `is_audio_direct` | 播放与转码 |
| `bitrate` / `file_size_bytes` / `runtime_seconds` | 用于上行估算 |
| `start_position_seconds` / `end_position_seconds` / `played_seconds` | 观看进度 |
| `watch_start_locked` / `watch_fields_frozen` | 起点锁定与字段冻结 |
| `seek_count` / `seek_forward_count` / `seek_backward_count` / `last_seek_at` | 跳转统计 |
| `upload_accumulator_key` | 外网流量累加器匹配键 |
| `estimated_upload_bytes` / `estimated_upload_source` | 估算上行（`accumulator` 或 `formula`） |
| `is_paused` | 播放中是否暂停（仅 playing 态有意义） |

### 3.4 迁移与清理

启动或首次访问时 `_migrate_instance_store` 会：

- 删除旧版「活动日志形态」JSON（`events[]` 无 `records[]`）
- 将历史 `*_2.json` 重命名或去重合并到主文件

实例删除/重命名时：`delete_instance_records` / `rename_instance_records`（与 Emby 配置生命周期联动）。

---

## 4. 播放段生命周期（`tick_from_sessions`）

入口：`EmbyInstanceWorker._tick` → `playback_record_store.tick_from_sessions(instance_name, sessions, api_online=...)`

### 4.1 段匹配键

优先顺序：

1. 运行时映射 `sid:{emby_session_id}` → record id
2. 运行时映射 `track:{user_id}|{client}|{item_id}` → record id
3. 遍历 `records[]` 中 `status=playing` 且 `_segment_key` 相同

### 4.2 开始新段

条件：活跃 Sessions 中存在播放项，且找不到 open record。

动作：`_new_record` → 分配 id → `emby_watch_progress.begin_pair_watch` → 插入 `records` 头部。

### 4.3 更新进行中段

每个 tick：`_apply_session_meta` + `emby_watch_progress.update_for_record` → 更新 `last_tick_at`、位置、转码信息等。

### 4.4 结束段（`status=ended`）

触发条件：

- Sessions 中不再出现该 open record（用户停止或切项）
- 同一 session 的 `item_id` 变化（先 end 旧段，再开新段）

动作：`_finalize_record`：

1. 写入 `stopped_at`
2. `emby_watch_progress.finalize_watch_to_event` 冻结观看字段
3. 若无 `played_seconds`，用墙钟 `started_at`～`stopped_at` 估算
4. `resolve_upload_bytes` 解析外网估算上行
5. `ended` 或带估算的 `incomplete` → `save_playback_upload_fact` 入库
6. 清理 tracker 与 sid 映射

### 4.5 离线超时（`status=incomplete`）

API 连续不可达超过 `OFFLINE_TIMEOUT_SECONDS`（30 分钟）后，将所有 `playing` 段标记为 `incomplete`，`interrupt_reason=timeout_offline`。

### 4.6 列表排序与容量

保存时：`playing` 在前，已结束按 `stopped_at` 降序；截断至 500 条。

---

## 5. 观看进度追踪（`emby_watch_progress.py`）

### 5.1 Tracker 维度

Key：`{user_id}|{normalized_client}|{item_id 或 series|label}`

每个播放段绑定独立 `SessionWatchState`，新段开始时 `reset_pair`。

### 5.2 Tick 逻辑要点

- 连续播放满 `WATCH_LOCK_SECONDS`（30s）后锁定 `start_position_seconds`
- 检测 seek：位置回退或跳跃超过 `elapsed + SEEK_TOLERANCE_SECONDS`
- 暂停时不累计 `played_seconds`
- 单次 poll 间隔封顶 `MAX_POLL_GAP_SECONDS`（15s）防时钟跳变

### 5.3 服务重启恢复

`playing` 段从 JSON `hydrate_from_record` 恢复 tracker，避免重启后起点被当前进度覆盖。

### 5.4 冻结

段结束时 `watch_fields_frozen=true`，后续 tick 不再覆盖观看字段。

---

## 6. Sessions 数据获取与规范化

### 6.1 API 调用

`EmbyClient.get_sessions()` → `GET /Sessions`

采集器中：`get_normalized_sessions()` 仅保留含 `NowPlayingItem` 的会话，并 `normalize_session`。

### 6.2 规范化输出（核心字段）

从原始 Session 提取：用户、客户端、远端 IP、`is_remote`、播放方式、转码信息、片长/进度 ticks、媒体标题/集数/年份/文件大小/码率等。

### 6.3 外网判断

`RemoteEndPoint` → `parse_endpoint_ip` → `is_lan_ip` 取反 → `is_remote`。

私有网段、回环、链路本地均视为局域网。

### 6.4 实时会话增强

`enrich_sessions_playback_started_at`：为当前 Sessions 附加 `playback_started_at`，供设备卡片会话列表按开始时间稳定排序。

---

## 7. 外网流量与估算上行

### 7.1 问题

Docker 容器 `tx_bytes` 是**总量**，无法按 IP 拆分。需结合 Sessions 中外网客户端与码率，将增量分摊到各外网播放会话。

### 7.2 实例级外网过滤（容器统计）

`apply_wan_traffic_filter`：按外网会话码率占比，从 Docker 增量中截取外网部分写入 `emby_traffic_hourly`（实例总流量图表用）。

配置项：`wan_traffic_only`（默认 true）。

### 7.3 播放段级累加器

完整采集周期（`full=True`）且非离线补录时：

```
emby_playback_traffic.accumulate_wan_upload(instance, sessions, delta_up)
```

- `allocate_wan_upload_per_session`：仅分给外网且未暂停的会话
- 按 `session_stream_bps` 比例分配
- 累加键：`playback_accumulator_key` = `user|client|item_id`（或集数/标题降级）

### 7.4 段结束时取上行

`emby_playback_upload_sync.resolve_upload_bytes`：

1. 已有 `estimated_upload_bytes` → 直接返回
2. `try_take_upload`：从累加器 `take_accumulated_upload`（信任 Docker 实测分摊）
3. 失败则 `estimate_upload_from_playback` 公式兜底：
   - 转码：`bitrate × played_seconds / 8`
   - 直传/串流：`file_size × watch_ratio`（无 seek 用片内跨度比，有 seek 用 played/runtime，封顶 3 倍片长）

`estimated_upload_source`：`accumulator` 或 `formula`。

### 7.5 SQLite 用户上行（图表专用）

表：

- `emby_playback_upload_facts`：每 ended 外网段一条（`instance_name + segment_id` 唯一）
- `emby_playback_upload_hourly`：按用户小时聚合

仅 `is_remote=true` 且 `estimated_upload_bytes>0` 的段在 `_persist_upload_fact` 时写入。

---

## 8. 调度集成（`emby_scheduler.py`）

`EmbyInstanceWorker._tick` 每次循环：

| 步骤 | full 周期 | 轻量周期 |
|------|-----------|----------|
| API 在线探测 | ✓ | ✓ |
| 拉 Sessions | ✓（在线时） | ✓（在线时） |
| `tick_from_sessions` | ✓ | ✓ |
| Docker stats | ✓ | 仅增量估算时用 |
| 外网过滤 + save_snapshot | ✓ | — |
| accumulate_wan_upload | ✓（有外网增量且非 backfill） | — |

双频率：`collect_interval`（默认 5s）完整采集 + `refresh_interval`（默认 1s）轻量探测，与 qB 监控共用 `ticks_per_full_collect` 逻辑。

---

## 9. Web API

| 路由 | 说明 |
|------|------|
| `GET /api/emby/playback-records?instance=&limit=` | 读取 JSON 播放记录列表 |
| `GET /api/emby/activity-log?instance=&limit=` | 原始活动日志（对照） |
| `GET /api/emby/playback-users?instance=` | 有入库上行数据的用户名列表 |
| `GET /api/emby/playback-stats/:instance/:period?user=` | 单用户外网上行统计（hourly/daily/weekly/monthly/yearly/cycle） |
| `GET /api/emby/status` / `/api/emby/status/live` | 实例状态含 `sessions`（含 `playback_started_at`） |

---

## 10. 前端播放记录卡片（`emby.js`）

### 10.1 数据流

1. 事件日志 Tab → 设备类型 Emby → 日志类型「新版日志」
2. `loadEmbyPlaybackRecords` → `/api/emby/playback-records`
3. `renderPlaybackRecords` → 每条 `renderPlaybackRecordCard`

### 10.2 卡片结构（一段一卡）

- **时间行**：playing 显示开始时间；ended 显示 `开始 - 结束` 区间；`incomplete+timeout_offline` 显示「超时中断」徽章
- **类型行**：用户徽章 + 状态徽章（播放中/已暂停/播放完毕）+ 设备名 + 脱敏 IP（可点击眼睛Reveal）
- **标题行**：剧名 — 集名 / 电影名 + SxxExx / 年份徽章
- **观看信息**（已结束）：影片时长 | 起止位置 | 观看完毕/已观看 N% | 时长徽章
- **播放中**：影片时长 | 起止位置 | 预计结束时间
- **标签行**：跳转次数、外网/局域网、转码类型、估算上行（仅外网 ended）

### 10.3 播放中实时刷新

`refreshEmbyLiveMetrics` 轮询 `/api/emby/status/live`：

- 有 `playing` 记录时先 `mergeLiveSessionIntoPlaybackRecord` 合并 live session 再本地重绘
- 再静默 `loadEmbyPlaybackRecords(true)` 拉取后端最新 JSON

### 10.4 用户筛选

从当前 records 动态填充 `embyEventPlaybackUser` 下拉，前端 `filterPlaybackRecordsByUser` 过滤。

### 10.5 与原始日志 UI 复用

`playbackRecordAsEvent` 将 record 映射为 `VideoPlayback` / `VideoPlaybackStopped` 类型，复用 `buildEmbyPlaybackCardTailHtml`、`buildEmbyEventMediaTitleHtml` 等函数，保证新旧日志视觉一致。

---

## 11. 与旧方案对比

| 项目 | 旧方案（活动日志 / events[] JSON） | 当前方案（Sessions 自写 records[]） |
|------|--------------------------------------|-------------------------------------|
| 数据源 | ActivityLog + 文本解析配对 | `/Sessions` 轮询 |
| 存储形态 | `events[]` 或 `*_2.json` 并行 | 单文件 `records[]` |
| 卡片粒度 | start/stop 合并或分散 | 天然一段一卡 |
| 观看进度 | 不稳定或缺失 | tracker 精确累计 |
| 外网上行 | 难与 Docker 对齐 | 累加器 + 公式双路径 |
| 界面入口 | — | 「新版日志」vs「原始日志」 |

---

## 12. 配置与运维要点

- Emby 功能总开关：`config.yaml` → `global.emby_enabled`
- 每实例：`api_key`、`host`、`port`、`wan_traffic_only`
- JSON 与 SQLite 随实例删除/重命名联动清理
- 播放记录上限 500 条/实例，超出按时间淘汰已结束段
- 局域网播放不写 `estimated_upload_bytes`，不入用户上行表

---

## 13. 数据流时序（单次外网播放）

```
T0  用户开始播放 → Sessions 出现 → tick 创建 playing record
T1… 每 refresh_interval tick 更新 meta + watch_progress + 累加器分摊 Docker 上行
T_end  Sessions 消失 → finalize → 冻结观看 → take 累加器 → 写 estimated_upload_bytes
      → save_playback_upload_fact → JSON 保存 ended record
前端  下次 load/render → 展示完整卡片（含估算上行徽章）
图表  playback-stats API 按用户聚合展示历史外网上行
```

---

## 14. 扩展与注意事项

1. **不要**在运行时批量把活动日志迁移为 records；正式数据应由 Sessions tick 自然产生。
2. 离线补录（`is_backfill`）不把间隙流量分摊到当前会话，避免错误归属。
3. 累加器路径信任 Docker 实测，不做公式封顶；公式路径才 `cap_estimated_upload_bytes`。
4. `EmbyClient` 中活动日志相关方法仍保留，仅供「原始日志」Tab 与潜在 enrichment 使用，不参与新版 JSON 写入主路径。

---

*文档生成自当前代码库实现，对应模块版本以仓库内源文件为准。*
