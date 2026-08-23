# ============================================================
# WinOJ 配置示例（example-config/）
# ------------------------------------------------------------
# 使用方法：将本目录中的文件复制到 config/ 目录后按需修改，
# 例如：copy example-config\* config\
#
# 注意：
#  - config/ 目录已被 .gitignore 忽略，不会提交到仓库；
#  - 请勿在真实 config/ 中填入占位值/真实密钥后再提交。
#  - 以下配置在 config/ 缺失时自动生成或启用默认值，无需在此示例：
#      * jwt.txt   —— 缺失时服务启动自动生成强随机密钥
#      * captcha.txt —— 缺失时默认开启（CAPTCHA_ENABLED=true）
#      * register.txt —— 缺失时默认开放注册（REGISTER_ENABLED=true），也可在管理面板(超管)直接切换
#      * judge.txt —— 缺失时默认按 CPU 核数自动确定 MAX_THREADS
#  - 只有 ai.txt / email.txt / cors.txt / register.txt 需要按需配置。
# ============================================================
