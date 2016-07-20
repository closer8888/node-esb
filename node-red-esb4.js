process.env.NODE_ENV = 'production';
var eventemitter = require("events").EventEmitter;
var events = new eventemitter();
var when = require('when');
var scanner = require('ss_portscanner');
var fork = require('child_process').fork;
var http = require('http');
var proxy = require('http-proxy').createProxyServer({ws:true});
var express = require("express");
//var RED = require("node-red");
var app = express();
//var expressWs = require("express-ws")(app);
var server;

var ss_io = require("flowController/ss_io");

app.use('/esb-server/esb-api*', function(req, res, next){
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
});
app.use('/esb-server/esb-api*', function auth(req, res, next){
    console.log('server authentication...for ' + req.url);
    next();
});

var fs = require('fs');
var path = require("path");
var util = require("util");
var content;
var conts;
var ss_db_server = '192.168.1.24';
var ss_db_pwd = 'dpuser';
try{
    var conts = fs.readFileSync('/SitscapeData/PROD/conf/ss_installation.ini').toString().split("\n");
    var variables = {};
    if(conts.length > 0){
        conts.forEach(function(val, ind, arr){
            var tmp_val = val.split('=');
            var new_val = tmp_val[1];
            if(tmp_val.length > 3){
                for(var j=2;j<tmp_val.length;j++){
                    new_val += tmp_val[j];
                }
            }
            if(typeof new_val != 'undefined' && tmp_val[0] != '' && typeof tmp_val[0] != 'undefined'){
                variables[tmp_val[0]] = new_val;
            }
        });
        ss_db_server = variables['SS_DB_SERVER'];
        var tmp_1 = variables['SS_DB_USER_PASS'].split("'");
        if(tmp_1[1] != ''){
            ss_db_pwd = new Buffer(tmp_1[1], 'base64').toString('ascii');
            ss_db_pwd = ss_db_pwd.replace(new RegExp('\n', 'g'), '');
        }
    }
}catch(exc){
    
}


server = http.createServer(app);
server.listen(9100);
var pipelines = {};
var portRange = {start:12000, end:22000};

var RedSettings = {
    mysql: {
        host : ss_db_server,
        user : "dpuser",
        password : ss_db_pwd,
        database : "sitscape"
    },
    flows : {id : 0},
    storageModule : "mysql"
};
//Set up the storage operator to get and start already running flows if server restarts.
var storage = require('node-red/red/storage');
storage.init(RedSettings).then(function(result){
    storage.getAllStates().then(function(result){
        for(var i=0; i<result.length; i++){
            item = result[i];
console.log("Auto initing " + item.item_id + ". State is " + item.state);
            switch(item.state){
                case "paused":
                    if(!pipelines[item.item_id]){
                        createFlowInstance(item.item_id).then(function(id){
                            initFlowInstance(id);
                        }, function(err){
console.log(err);
                        });
                    }else{  //Never should get here because none of these are created coming out of the DB.
                        initFlowInstance(item.item_id);
                    }
                    break;
                case "running":
                    createFlowInstance(item.item_id).then(function(id){
console.log("Line 62 Flow created for " + id + ". Now running init");
                        //wait for the flows to be initialized before starting the flows
                        events.once(id + "_flows initialized", function(){
                            startFlowInstance(id);
                        });
                        initFlowInstance(id).then(function(id){
                            
                            
                            
                        }).catch(function(err){
                            console.log(err);
                        });
                    }).catch(function(err){
                        console.log(err);
                    });
                    break;
            }
        }
    }, function(err){
console.log(err);
    });
}, function(err){
console.log(err);
});

//********** Start webserver control commands ***************************
app.get('/esb-server/esb-api/create/:id', function(req, res, next){
    try{        
        var response = ss_io.createResponse();
        response.setCode(200);
        response.setInstanceId(req.params.id);
        createFlowInstance(req.params.id).then(function(result){
            response.addMessage(result);
            res.status(200).json(response.toObject());
            next();
        }, function(err){
console.log(err);
            response.addError(err);
            res.status(500).send(response.toObject());
            next();
        });
    }catch(e){
        console.log(e);
        next();
    }
});

app.get('/esb-server/esb-api/init/:id', function(req, res, next){
    var response = ss_io.createResponse();
    response.setCode(200);
    response.setInstanceId(req.params.id);
    if(!pipelines[req.params.id]){
        createFlowInstance(req.params.id).then(function(){
            initFlowInstance(req.params.id).then(function(result){
                response.addMessage(result);
                res.json(response.toObject());
                next();
            }, function(err){
                response.addError(err);
                res.status(500).json(response.toObject());
                next();
            });
        }, function(err){
console.log(err);
            response.addError(err.message);
            res.status(500).json(response.toObject());
            next();
        });
    }else{
        initFlowInstance(req.params.id).then(function(result){
            response.addMessage(result);
            res.json(response.toObject());
            next();
        }, function(err){
            response.addError(err.message);
            res.status(500).json(response.toObject());
            next();
        });
    }
});

//Resume or start a flowInstance
app.get(['/esb-server/esb-api/start/:id', '/esb-server/esb-api/resume/:id'], function(req, res, next){
    var response = ss_io.createResponse();
    response.setCode(200);
    response.setInstanceId(req.params.id);
    if(!pipelines[req.params.id]){
        response.addError("This flow instance has not been created yet.");
        res.status(500).json(response.toObject());
        next();
    }else if(pipelines[req.params.id].status === 'created'){
        response.addError("This flow instance has not been initialized yet.");
        res.status(500).json(response.toObject());
        next();
    }else{
        startFlowInstance(req.params.id).then(function(result){
            response.addMessage(result);
            res.json(response.toObject());
            next();
        }, function(err){
            response.addError(err.message);
            res.status(500).json(response.toObject());
            next();
        });
    }
});

//Pause a running flowInstance
app.get(['/esb-server/esb-api/stop/:id', '/esb-server/esb-api/pause/:id'], function(req,res,next){
    var response = ss_io.createResponse();
    response.setCode(200);
    response.setInstanceId(req.params.id);
    if(!pipelines[req.params.id]){
        response.addError("This flow instance has not been created yet.");
        res.status(500).json(response.toObject());
        next();
    }else if(pipelines[req.params.id].status === "created"){
        response.addError("This flow instance has not been initialized yet.");
        res.status(500).json(response.toObject());
        next();
    }else if(pipelines[req.params.id].status === "paused"){
        response.addError("This flow instance is already paused .");
        res.status(500).json(response.toObject());
        next();
    }else{
        stopFlowInstance(req.params.id).then(function(result){
            response.addMessage(result);
            res.json(response.toObject());
            next();
        }, function(err){
            response.addError(err.message);
            res.status(500).json(response.toObject());
            next();
        });
    }
});
app.get('/esb-server/esb-api/destroy/:id', function(req,res,next){
    var response = ss_io.createResponse();
    response.setCode(200);
    response.setInstanceId(req.params.id);
    destroyFlowInstance(req.params.id).then(function(result){
        response.addMessage(result);
        res.json(response.toObject());
        next();
    }, function(err){
        response.addError(err.message);
        res.status(500).json(response.toObject());
        next();
    });
});
app.get('/esb-server/esb-api/status/:id', function(req, res, next){
    var response = ss_io.createResponse();
    response.setCode(200);
    response.setInstanceId(req.params.id);
    if(pipelines[req.params.id]){
        response.addMessage(pipelines[req.params.id].status);
    }else{
        response.addMessage("undefined");
    }
    res.json(response.toObject());
    next();
});
app.get('/esb-server/esb-api/status', function(req, res, next){
    var response = ss_io.createResponse();
    response.setCode(200);
    response.addMessage("esb server is running");
    res.json(response.toObject());
    next();
});
app.get('/esb-server/esb-api/listflows', function(req, res, next){
    var response = ss_io.createResponse();
    response.setCode(200);
    for(var i in pipelines){
        response.addMessage(i);
    }
//    response.addMessage("esb server is running");
    res.json(response.toObject());
    next();
});
app.get('/esb-server/esb-api/shutdown/:id', function(req,res,next){
    var response = ss_io.createResponse();
    response.setCode(200);
    response.setInstanceId(req.params.id);
    shutdownFlowInstance(req.params.id).then(function(result){
        response.addMessage(result);
        res.json(response.toObject());
        next();
    }, function(err){
        response.addError(err.message);
        res.status(500).json(response.toObject());
        next();
    });
});
//********** End webserver control commands ***************************

app.get('/esb-server/red/:id', function(req, res){
    if(pipelines[req.params.id]){
        proxy.web(req, res, {target:"http://127.0.0.1:" + pipelines[req.params.id].httpPort}, function(e){
            console.log(e);
        });
    }
});
app.all('/esb-server/red/:id/', function(req, res){
    if(pipelines[req.params.id]){
        proxy.web(req, res, {target:"http://127.0.0.1:" + pipelines[req.params.id].httpPort}, function(e){
            console.log(e);
        });
    }
});

app.get('/esb-server/red/:id/*', function(req, res){
    if(pipelines[req.params.id]){
        proxy.web(req, res, {target:"http://127.0.0.1:" + pipelines[req.params.id].httpPort}, function(e){
            console.log(e);
        });
    }
});
app.post('/esb-server/red/:id/*', function(req, res){
    if(pipelines[req.params.id]){
        proxy.web(req, res, {target:"http://127.0.0.1:" + pipelines[req.params.id].httpPort}, function(e){
            console.log(e);
        });
    }
});

app.get('/esb-server/api/:id', function(req, res){
    if(pipelines[req.params.id]){
        proxy.web(req, res, {target:"http://127.0.0.1:" + pipelines[req.params.id].httpPort});
    }
});
app.get('/esb-server/api/:id/', function(req, res){
    if(pipelines[req.params.id]){
        proxy.web(req, res, {target:"http://127.0.0.1:" + pipelines[req.params.id].httpPort});
    }
});
app.get('/esb-server/api/:id/*', function(req, res){
    if(pipelines[req.params.id]){
        proxy.web(req, res, {target:"http://127.0.0.1:" + pipelines[req.params.id].httpPort});
    }
});

proxy.on('error', function(e){
    console.log(e);
});
server.on('upgrade', function (req, socket, head) {
    var match = req.url.match(/\/red\/(.*)\/comms/);
    if(match && match.length > 1 && match[1] && pipelines[match[1]]){
        console.log(match[1] + " : upgrading to websocket");
        console.log(pipelines[match[1]].httpPort);
        proxy.ws(req, socket, head, {target:"ws://127.0.0.1:" + pipelines[match[1]].httpPort, ws:true});
    }
});

function createFlowInstance(id){
//    var id = id;
    return when.promise(function(resolve, reject){
        if(!id){
            reject(Error('Function call to createFlowInstance is missing id.'));
        }
        if(pipelines[id]){
            reject(Error('pipelines[' + id + '] already exists'));
        }
        pipelines[id] = {child:null, httpPort:null, status: "created"};
        scanner.findAPortNotInUse(portRange.start, portRange.end, '127.0.0.1', function(error, port){
console.log('got port #' + port + " for id " + id);
            if(error){
                reject(Error('An error occurred while attempting to find an open port'));
            }else{
                var options = JSON.stringify({
                    id : id,
                    listenPort : port,
                    RedSettings : RedSettings
                });
                events.once(id + "_flows created", function(){
console.log("flows have been created for " + id);
                    resolve(id);
                });
                pipelines[id].child = fork('./node_modules/flowController', [options]);
                
                pipelines[id].httpPort = port;
                //listen for messages from child processes and emit them in this parent process
                pipelines[id].child.on("message", function(message){
                    events.emit(id + "_" + message.command);
                });
                pipelines[id].child.on("exit", function(code, signal){
                    delete pipelines[id];
                });
            }
        });
    });    
}

function initFlowInstance(id){
//    var id = id;
console.log('trying to init ' + id);
    return when.promise(function(resolve, reject){
        if(!id){
            reject(Error('Function call to initFlowInstance is missing id.'));
        }
        if(!pipelines[id]){
            reject(Error('pipelines[' + id + '] does not exist.'));
        }
        if(pipelines[id].status === "created"){
            events.once(id + "_flows initialized", function(){
                resolve(id);
            });
            pipelines[id].child.send({
            command : 'startFlow'
            });
            pipelines[id].status = "paused";
console.log('initializing ' + id);
            
        }else{
            reject(Error(id + " is already initialized."));
        }
    });
}

function startFlowInstance(id){
    return when.promise(function(resolve, reject){
        if(!id){
            reject(Error('Function call to startFlowInstance is missing id.'));
        }
        if(!pipelines[id]){
            reject(Error('pipelines[' + id + '] does not exist.'));
        }
        if(pipelines[id].status === "paused"){
            pipelines[id].status = "running";
            pipelines[id].child.send({
                command : 'resumeFlow'
            });
            resolve(id);
        }else if(pipelines[id].status === "running"){
            reject(Error('pipelines[' + id + '] is already running.'));
        }else{
            reject(Error('pipelines[' + id + '] is not initialized yet.'));
        }
    });    
}

function stopFlowInstance(id){
    return when.promise(function(resolve, reject){
        if(!id){
            reject(Error('Function call to stopFlowInstance is missing id.'));
        }
        if(!pipelines[id]){
            reject(Error('pipelines[' + id + '] does not exist.'));
        }
        if(pipelines[id].status === "running"){
            pipelines[id].status = "paused";
            pipelines[id].child.send({
                command : 'pauseFlow'
            });
            resolve(id);
        }else{
            reject(Error('pipelines[' + id + '] is not running or is not initialized.'));
        }        
    });
}

function destroyFlowInstance(id){
    return when.promise(function(resolve, reject){
        if(!id){
            reject(Error('Function call to destroyFlowInstance is missing id.'));
        }
        if(!pipelines[id]){
            reject(Error('pipelines[' + id + '] does not exist.'));
        }
        if(pipelines[id].status !== "destroyed"){
            pipelines[id].status = "destroyed";
            pipelines[id].child.send({
                command : 'destroyFlow'
            });
console.log('Removing ' + id);
            delete pipelines[id];
            resolve(id);
        }else{
            reject(Error('pipelines[' + id + '] is in the process of being destroyed.'));
        }
    });
}

function shutdownFlowInstance(id){
    return when.promise(function(resolve, reject){
        if(!id){
            reject(Error('Function call to shutdownFlowInstance is missing id.'));
        }
        if(!pipelines[id]){
            reject(Error('pipelines[' + id + '] does not exist.'));
        }
        if(pipelines[id].status !== "shutdown"){
            pipelines[id].status = "shutdown";
            pipelines[id].child.send({
                command : 'shutdownFlow'
            });
console.log('shutdown ' + id);
            delete pipelines[id];
            resolve(id);
        }else{
            reject(Error('pipelines[' + id + '] is in the process of being shutdown.'));
        }
    });
    
}