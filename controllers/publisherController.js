const { redisKeys } = require('../lib/constants');
const redisService = require('../services/redisService');
const userController = require('./userController');
const {z:zod} = require('zod');

const emitSchema = zod.object({
    userId: zod.string(),
    type: zod.number().min(1).max(2),
    timeStamp: zod.number(),
});

let sendEmit = async ()=>{
    let request = await redisService.redis("lpop",`${redisKeys.emitRequestData}`);
    if(request){
        try{
            request = JSON.parse(request);
            emitSchema.parse(request);
            const lastActivity=await redisService.redis("hgetall",`${redisKeys.userLastRequest}:${request.userId}`);
            const isEmpty = Object.keys(lastActivity).length === 0;
            let cnt=0;
            if(request["type"]== 1){
                cnt=await redisService.redis("hget",`${redisKeys.userData}:${request.userId}`,'socketCnt');
                if(cnt){
                    ++cnt;
                    await redisService.redis("hset",`${redisKeys.userData}:${request.userId}`,'socketCnt',cnt);
                }else{
                    cnt=1
                    await redisService.redis("hset",`${redisKeys.userData}:${request.userId}`,'socketCnt',1);
                }
            }else{
                cnt=await redisService.redis("hget",`${redisKeys.userData}:${request.userId}`,'socketCnt');
                if(cnt && cnt>0){
                    --cnt;
                    await redisService.redis("hset",`${redisKeys.userData}:${request.userId}`,'socketCnt',cnt);
                }else{
                    cnt=0;
                    await redisService.redis("hset",`${redisKeys.userData}:${request.userId}`,'socketCnt',0);
                }
            }
            if(!isEmpty && lastActivity["type"] == request["type"]){
                //case when same type request come from user multiple times
                return;
            }
            //case when last request is older
            if(isEmpty || lastActivity["timeStamp"] <= request["timeStamp"]){
                //case of login
                if(request["type"]===1){
                    if(cnt==1){
                        await redisService.redis("hset",`${redisKeys.userData}:${request["userId"]}`,'lastseen_at',-1);
                        const workspaceids=await userController.getWorkspaceIds(request["userId"]);
                        workspaceids.forEach(async (wid) => {
                            io.to(wid).emit('userjoin', request["userId"]);
                        });
                    }
                    await redisService.redis("hset",`${redisKeys.userLastRequest}:${request["userId"]}`,"type",request["type"],"timeStamp",request["timeStamp"]);    
                    return;
                }
                //case of logout 
                if(cnt==0){    
                    console.log("semding logout");
                    await redisService.redis("hset",`${redisKeys.userData}:${request["userId"]}`,'lastseen_at',Date.now());
                    await userController.updateLastSeenUser(request["userId"],Date.now());
                    const workspaceids=await userController.getWorkspaceIds(request["userId"]);
                    workspaceids.forEach(async (wid) => {
                        io.to(wid).emit('userleft', request["userId"]);
                    });
                }
                await redisService.redis("hset",`${redisKeys.userLastRequest}:${request["userId"]}`,"type",request["type"],"timeStamp",request["timeStamp"]);
            }
        }catch(e){
            console.log("Error while parsing or executing the request",e);
            return;
        }
    }
};

module.exports = {
    sendEmit,
}