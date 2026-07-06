const express = require("express");
const redis = require("redis");
const dotenv = require("dotenv");
const OSS = require("ali-oss");

async function app () {
    dotenv.config({quiet: true});
    const redisConn = redis.createClient({url: process.env.REDIS});
    await redisConn.connect();
    const app = express();
    const PORT = process.env?.PORT || 3000;

    app.set("trust proxy", true);
    app.disable("x-powered-by");

    const client = new OSS({
        accessKeyId: process.env["ACCESS_ID"],
        accessKeySecret: process.env["ACCESS_SECRET"],
        region: process.env["REGION"],
        authorizationV4: true,
        cname: true,
        bucket: process.env["BUCKET"],
        endpoint: process.env["ENDPOINT"]
    });

    app.get("/{*splat}", async (req, res) => {
        const path = req.path;
        const ip = req.ip;
        // 查询ip是否被ban
        const banKey = `ban_ip:${ip}`;
        const ban = await redisConn.exists(banKey);
        if (ban) return res.status(403).send("您的IP地址已被限制访问该资源");
        // 设置qos，到达每分钟150次直接拉黑6小时
        let qosKey = `qos:${ip}`;
        const count = await redisConn.incr(qosKey);
        if (count === 1) await redisConn.expire(qosKey, 60);
        if (count > 150) {
            await redisConn.set(banKey, '1', { EX: 21600, NX: true });
            return res.status(403).send("您的IP地址已被限制访问该资源");
        }
        // 查找资源是否存在404
        if (await redisConn.exists(`404:${path}`)) return res.status(404).send("资源不存在");
        let request;
        try {
            request = await client.getStream(path, {
                headers: {
                    'Referer': 'sydnkj.cn'
                }
            });
            // 用户主动关闭
            req.on('close', () => {
                stream.destroy();
            });
            // 代理获取文件失败
            request.stream.on('error', (err) => {
                console.log(err);
                stream.destroy();
                if (!res.headersSent) {
                    return res.status(500).send("获取资源失败");
                }
            });
            request.stream.pipe(res);
        } catch (err) {
            let message;
            if (err.status === 404) {
                message = '资源不存在';
                (async () => await redisConn.set(`404:${path}`, '1', { EX: 600}))();
            }
            return res.status(err.status ?? 500).send(message || "无法获取资源");
        }
    })

    const server = app.listen(PORT, "0.0.0.0");
    server.on("listening", () => {
        console.log(`[OSS Proxy] 服务已启动，正在监听端口: ${PORT}`)
    });
}
app();