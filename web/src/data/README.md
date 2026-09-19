# Emoji 中文检索数据

`emoji-zh.json` 来自 Unicode CLDR 简体中文 annotations 与 annotationsDerived，按 Emoji Mart Unicode 15 原生图标 ID 匹配，保留名称与关键词。Unicode variation selector FE0F 不参与匹配；不包含与现有图标无关的注释。

- 来源：https://github.com/unicode-org/cldr-json/tree/1aaabe99aa652d6f22ea488cf25baea46aa69b42
- 原始文件：`cldr-json/cldr-annotations-full/annotations/zh/annotations.json`、`cldr-json/cldr-annotations-derived-full/annotationsDerived/zh/annotations.json`
- 匹配 1870 / 1870 个基础图标；未匹配项保留原英文搜索。
- 许可见 `UNICODE-LICENSE.txt`。资源本地打包，随图标选择器按需加载，不发送搜索词到外部服务。
