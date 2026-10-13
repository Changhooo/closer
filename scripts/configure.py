"""Write deployment configuration with random secrets; never overwrites .env."""
import argparse
import ipaddress
import os
from pathlib import Path
import re
import secrets


def domain(value):
    if not re.fullmatch(r'(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}', value):
        raise argparse.ArgumentTypeError('请输入域名，不含 https://、路径或端口')
    return value.lower()


def main():
    parser = argparse.ArgumentParser(description='生成同屏 Lite 的 .env 配置')
    parser.add_argument('domain', type=domain)
    parser.add_argument('--turn-host', type=domain)
    parser.add_argument('--turn-ip', type=ipaddress.ip_address)
    parser.add_argument('--participants', type=int, default=6, choices=range(2, 17))
    args = parser.parse_args()
    if bool(args.turn_host) != bool(args.turn_ip):
        parser.error('--turn-host 和 --turn-ip 需要同时指定')
    root = Path(__file__).resolve().parents[1]
    path = root / '.env'
    content = [f'SHARE_DOMAIN={args.domain}', f'ACCESS_KEY={secrets.token_urlsafe(24)}',
               f'MAX_PARTICIPANTS={args.participants}', 'MAX_ROOMS=200',
               'ROOM_TTL_SECONDS=21600', 'IDLE_TTL_SECONDS=1800',
               f'STUN_URLS=stun:{args.turn_host}:3478' if args.turn_host else 'STUN_URLS=stun:stun.cloudflare.com:3478']
    if args.turn_host:
        content += [f'TURN_URLS=turn:{args.turn_host}:3478?transport=udp,turn:{args.turn_host}:3478?transport=tcp',
                    f'TURN_SECRET={secrets.token_urlsafe(48)}', f'TURN_DOMAIN={args.turn_host}', f'TURN_PUBLIC_IP={args.turn_ip}']
    else:
        content += ['TURN_URLS=', 'TURN_SECRET=', 'TURN_DOMAIN=', 'TURN_PUBLIC_IP=']
    content += ['RELAY_ONLY=false']
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        parser.error('.env 已存在，未覆盖。请直接编辑现有配置。')
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        output.write('\n'.join(content) + '\n')
    print('已生成 .env。创建房间口令在 ACCESS_KEY 一行；请妥善保管，不要提交到 GitHub。')
    print('启动：docker compose ' + ('-f compose.yml -f compose.turn.yml ' if args.turn_host else '') + 'up -d --build')


if __name__ == '__main__':
    main()
