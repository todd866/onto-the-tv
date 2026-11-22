/* Bounded runtime diagnostics; no error message, URL or document content. */
(function () {
  function report(phase,e) {
    var name=e && e.error && e.error.name;
    if(['TypeError','ReferenceError','SyntaxError','RangeError','Error'].indexOf(name)<0) name='unknown';
    window.parent.postMessage({type:'uke:probe',phase:phase,errorName:name,line:Math.min(1000000,Math.max(0,Number(e && e.lineno)||0)),column:Math.min(1000000,Math.max(0,Number(e && e.colno)||0))},'*');
  }
  window.addEventListener('error',function(e){report('error',e);},true);
  window.addEventListener('unhandledrejection',function(){report('error');});
  report('boot');
}());
