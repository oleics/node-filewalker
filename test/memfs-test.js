var filewalker = require('..');
var assert = require('assert');
var path = require('path');
var memfs = require('memfs');

describe('Filewalker', function() {

    it('works with a different fs', function( done ) {

        var fs = memfs.fs;
        var currDir = path.normalize(process.cwd());
        var memDir = path.join(currDir, 'mem');
        var fooFile = path.join(memDir, 'foo.txt');

        fs.mkdirSync( currDir, { recursive: true } ); // Synchronize with the current dir
        fs.mkdirSync( memDir );
        fs.writeFileSync( fooFile, 'hello' );

        var options = {
            fs: fs
        };

        var dirs = [];
        var files = [];

        filewalker( currDir, options )
            .on('dir', function(p, s, fullPath) {
                dirs.push(fullPath);
            })
            .on('file', function(p, s, fullPath) {
                files.push(fullPath);
            })
            .on('done', function() {
                assert.notEqual(dirs.indexOf(memDir), -1);
                assert.notEqual(files.indexOf(fooFile), -1);
                done();
            })
            .walk();
    });

});