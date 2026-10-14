@echo off
chcp 65001 >nul
title SD-IPTV local relay (NAT punch)
cd /d "%~dp0"
echo.
echo  山东联通单播本地中转启动中...
echo  播放器订阅地址:  http://本机IP:8899/list.m3u
echo  关闭此窗口即停止
echo.
python relay.py %*
pause
