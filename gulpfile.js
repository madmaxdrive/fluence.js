const { src, dest, parallel } = require('gulp');
const ts = require('gulp-typescript');
const tsProject = ts.createProject('tsconfig.json');

function compile() {
  return tsProject.src().pipe(tsProject()).pipe(dest('dist'));
}

function copy() {
  return src('src/*.json').pipe(dest('dist'));
}

exports.default = parallel(compile, copy);
