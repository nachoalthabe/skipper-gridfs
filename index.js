/**
 * Module dependencies
 */

var path = require('path');
var util = require('util');
var Writable = require('stream').Writable;
var mongodburi = require('mongodb-uri');
var _ = require('lodash');
var concat = require('concat-stream');
var Grid = require('gridfs-stream');

var mongo = require('mongodb'),
GridStore = require('mongodb').GridStore,
MongoClient = require('mongodb').MongoClient;

/**
 * skipper-gridfs
 *
 * @param  {Object} globalOpts
 * @return {Object}
 */

module.exports = function GridFSStore (globalOpts) {
    globalOpts = globalOpts || {};

    _.defaults(globalOpts, {

        database: 'your-mongodb-name',

        host: 'localhost',

        port: 27017,

        bucket: GridStore.DEFAULT_ROOT_COLLECTION,

        user: '',

        password: '',

        uri: ''
    });

    _setURI();

    var adapter = {
        ls: function (dirname, cb) {
            MongoClient.connect(globalOpts.uri, {native_parser:true}, function(err, db) {
                if (err) return cb(err);
                var gfs = Grid(db, mongo);
                gfs.collection(globalOpts.bucket).ensureIndex({filename: 1, uploadDate: -1}, function(err, indexName) {
                    if (err) {
                        db.close();
                        return cb(err);
                    }

                    gfs.collection(globalOpts.bucket).distinct('filename', {'metadata.dirname': dirname}, function(err, files) {
                        db.close();
                        if (err) return cb(err);
                        return cb(null, files);
                    });
                });
            });
        },

        read: function(fd, cb) {
            MongoClient.connect(globalOpts.uri, {native_parser:true}, function(err, db) {
                GridStore.exist(db, fd, globalOpts.bucket, function(err, exists) {
                    if (err) {
                        db.close();
                        return cb(err);
                    }
                    if (!exists) {
                        err = new Error('ENOENT');
                        err.name = 'Error (ENOENT)';
                        err.code = 'ENOENT';
                        err.status = 404;
                        err.message = util.format('No file exists in this mongo gridfs bucket with that file descriptor (%s)', fd);
                        db.close();
                        return cb(err);
                    }
                    /*
                    GridStore.read(db, fd, null, null, {root: globalOpts.bucket}, function(err, fileData) {
                        db.close();
                        if (err) return cb(err);
                        return cb(null, fileData);
                    });
                    */
                    var gridStore = new GridStore(db, fd, "r");
                    gridStore.open(function(err, gridStore) {
                      var stream = gridStore.stream(true);
                      return cb(false,stream);
                    });
                });

            });
        },

        readLastVersion: function (fd, cb) {
            this.readVersion(fd, -1, cb);
        },

        readVersion: function(fd, version, cb) {
            MongoClient.connect(globalOpts.uri, {native_parser:true}, function(err, db) {
                if (err) return cb(err);
                var gfs = Grid(db, mongo);
                gfs.collection(globalOpts.bucket).ensureIndex({filename: 1, uploadDate: -1}, function(err, indexName){
                    if (err) {
                        db.close();
                        return cb(err);
                    }

                    var cursor = gfs.collection(globalOpts.bucket).find({filename: fd});
                    if (version < 0) {
                        skip = Math.abs(version) - 1
                        cursor.limit(-1).skip(skip).sort([['uploadDate', 'desc']])
                    } else {
                        cursor.limit(-1).skip(version).sort([['uploadDate', 'asc']])
                    }

                    cursor.nextObject(function(err, file) {
                        if (err) {
                            db.close();
                            return cb(err);
                        }
                        if (!file) {
                            err = new Error('ENOENT');
                            err.name = 'Error (ENOENT)';
                            err.code = 'ENOENT';
                            err.status = 404;
                            err.message = util.format('No file exists in this mongo gridfs bucket with that file descriptor (%s)', fd);
                            db.close();
                            return cb(err);
                        }
                        GridStore.read(db, file.filename, null, null, {root: globalOpts.bucket}, function(err, fileData) {
                            db.close();
                            if (err) return cb(err);
                            return cb(null, fileData);
                        });
                    });
                });
            });
        },

        rm: function(fd, cb) {
            MongoClient.connect(globalOpts.uri, {native_parser:true}, function(err, db) {
                if (err) return cb(err);
                var gfs = Grid(db, mongo);
                gfs.remove({filename: fd, root: globalOpts.bucket}, function(err, results) {
                    db.close();
                    if (err) return cb(err);
                    return cb();
                });
            });
        },

        /**
         * A simple receiver for Skipper that writes Upstreams to
         * gridfs
         *
         *
         * @param  {Object} options
         * @return {Stream.Writable}
         */
        receive: function GridFSReceiver (options) {
            options = options || {};
            options = _.defaults(options, globalOpts);

            var receiver__ = Writable({
                objectMode: true
            });

            // This `_write` method is invoked each time a new file is received
            // from the Readable stream (Upstream) which is pumping filestreams
            // into this receiver.  (filename === `__newFile.filename`).
            receiver__._write = function onFile(__newFile, encoding, done) {
                console.log('write fd:',__newFile.fd);
                var fd = __newFile.fd,
                    closed = false;


                console.log(globalOpts.uri);
                MongoClient.connect(globalOpts.uri, {native_parser:true}, function(err, db) {
                    console.log('Conecto');

                    if (err) return done(err);

                    receiver__.once('error', function (err) {
                      if(closed) return;
                      closed = true;
                      db.close();
                      console.log('ERROR ON RECEIVER__ ::',err);
                      done(err);
                    });

                    var gfs = Grid(db, mongo);
                    console.log('Opened connection for (%s)',fd);

                    var outs = gfs.createWriteStream({
                      filename: fd,
                      root: options.bucket,
                      metadata: {
                        fd: fd,
                        dirname: __newFile.dirname || path.dirname(fd)
                      }
                    });
                    __newFile.once('error', function (err) {
                      receiver__.emit('error', err);
                      console.log('***** READ error on file ' + __newFile.filename, '::', err);
                    });
                    outs.once('error', function failedToWriteFile(err) {
                      receiver__.emit('error', err);
                      console.log('Error on file output stream- garbage collecting unfinished uploads...');
                    });
                    outs.once('open', function openedWriteStream() {
                      console.log('opened output stream for',__newFile.fd);
                      __newFile.extra = _.assign({fileId: this.id}, this.options.metadata);
                    });
                    outs.once('close', function doneWritingFile(file) {
                      console.log('closed output stream for',__newFile.fd);
                      //mongoose.disconnect();
                      if(closed) return;
                      closed = true;
                      db.close();
                      done();
                    });
                    __newFile.pipe(outs);
                });
            };
            return receiver__;
        }
    };

    return adapter;











    // Helper methods:
    ////////////////////////////////////////////////////////////////////////////////

    function _setURI() {
      console.log(globalOpts.uri,(_URIisValid(globalOpts.uri))?'valida':'novalida');
        if (!globalOpts.uri || !_URIisValid(globalOpts.uri)) {
            var conf = {
                username: globalOpts.user,
                password: globalOpts.password,
                hosts: [{
                    host: globalOpts.host,
                    port: globalOpts.port
                }],
                database: globalOpts.database
            };
            console.log(conf);
            globalOpts.uri = mongodburi.format(conf);
        } else {
            var uriandbucket = globalOpts.uri.trim();
            //globalOpts.uri = uriandbucket.substring(0, uriandbucket.lastIndexOf('.'));
            //globalOpts.bucket = uriandbucket.substring(uriandbucket.lastIndexOf('.')+1);
        }
    }

    function _URIisValid(uri) {
        var regex = /^(mongodb:\/{2})?((\w+?):(\S+?)@|:?@?)([\w._-]+?):(\d+)\/([\w_-]+?).{0,1}([\w_-]+?)$/g;
        return regex.test(uri);
    }
};
