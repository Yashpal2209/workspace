const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const socketIO = require('socket.io');
const sio_redis = require('socket.io-redis');
const path = require('path');
const cookieParser = require('cookie-parser');

// CONFIG
const dotenv = require('dotenv')
dotenv.config();
global.argv = process.argv.slice(2);
const configVar = require('./config/configVars');


const app = express();
const server = require('http').Server(app);

const { connectRedis } = require('./config/redis');
global.redisClient = connectRedis();
global.sessionRedisClient = connectRedis({isSessionRedis: true});

const { constants, utils } = require('./lib');
const middelwares = require('./middlewares');

const authController = require('./controllers/authController');
const channelController = require('./controllers/channelController');
const messageController = require('./controllers/messageController');
const userActivityController = require('./controllers/userActivityController');
const userController = require('./controllers/userController');
const notificationController = require('./controllers/notificationController');
const emailService = require('./services/emailService');
const cookie = require('cookie');

const socketRoutes = require('./routes/socketRoutes');
const { redisService } = require('./services');
const { redisKeys } = require('./lib/constants');

app.use(express.json({limit: '50mb', extended: true}));
app.use(express.urlencoded({limit: '50mb', extended: true}));

app.use(express.static(path.join(__dirname, 'Public'), { }));
app.use(cors({
	origin: [
		configVar.frontendURL,
	],
	credentials: true,
}));

app.use(cookieParser());

io = require('socket.io')(server, {
	cors: {
		origin: "localhost",
		methods: ["GET", "POST"],
		credentials: true,
	},
});
io.adapter(sio_redis({host: 'localhost', port: 6379}));

io.use( async (socket, next) => {
	try {
		let cookies = cookie.parse(socket.request.headers.cookie);
		const sessionObj = await authController.authenticateSession(cookies?.jwt);
		if ( ! sessionObj )		throw new Error("Request is not authenticated");
		socket.userData = sessionObj;
		next();	
	} catch (e) {
		console.log(e)
		next({ error : "Invalid socket request"})
		return ;
	}
})

io.on('connection', async (socket) => {
	let userId = socket.userData && socket.userData.userId;
	let socketId = socket.id;
	socket.join(userId);
	const length = await redisService.redis('scard',`${redisKeys.userSocketData}:${userId}`);
	if(!length){
		const workspaceids=await userController.getWids(userId);
		workspaceids.forEach(async (wid) => {
			io.to(wid).emit('userjoin', userId);
		});
	}
	await redisService.redis("hset",`${redisKeys.userData}:${userId}`,'lastseen_at',-1);
	await redisService.redis('sadd',`${redisKeys.userSocketData}:${userId}`,socketId);
	socket.on('disconnect',async () => {
		socket.leave(userId);
		const length = await redisService.redis('scard',`${redisKeys.userSocketData}:${userId}`);
		await redisService.redis('srem',`${redisKeys.userSocketData}:${userId}`,socketId);
		if(length==1){
			await redisService.redis("hset",`${redisKeys.userData}:${userId}`,'lastseen_at',Date.now());
			await userController.updateLastSeenUser(userId,Date.now());
			const workspaceids=await userController.getWids(userId);
			workspaceids.forEach(async (wid) => {
				io.to(wid).emit('userleft', userId);
			});
		}
		channelController.setLastSeenOnSocketDisconnection({userId, socketId});
	});
	socketRoutes(socket, io);
});

app.use(middelwares.session.populateSession);

app.use((req, res, next) => {
	if (req.session.sid) {
		res.on('close', () => {
			if (req.session?.[constants.sessionUpdateCheckFieldName]) {
				req.session.save();
			}
		});
	}
	next();
})

app.use('/', require("./routes"));
app.use('/', require('./routes/fileUpload'));

server.listen( constants.listenPort, (err) => {
    if (err) {
        console.log("Error in starting server. Error = ", err);
        return ;
    }
    console.log(`Workspace server started on port ${constants.listenPort}`);
})


console.log("notificationChecker = ", parseInt(process.env.notificationChecker));
if (parseInt(process.env.notificationChecker))	notificationController.startNotificationIntervals();
else	messageController.startMessageWriteInterval();
userActivityController.startUserActivityWriteInterval();


process.on('SIGINT', function () {
	process.exit(0);
});

process.on('uncaughtException', function (err) {
	console.error("uncaughtException--", err);
})

process.on('unhandledRejection', (reason, p) => {
	console.error('Unhandled Rejection at:', p, 'reason:', reason);
	// application specific logging, throwing an error, or other logic here
});


setInterval( async () => {
	try {
		await emailService.popEmailFromEmailQueue();
	} catch (error) {
		console.log(error);
	}
}, 10000);
