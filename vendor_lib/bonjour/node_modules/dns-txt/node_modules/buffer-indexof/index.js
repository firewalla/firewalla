module.exports = function bufferIndexOf(buf,search,offset){
  offset = offset||0
  
  var m = 0;
  var s = -1;
  for(var i=offset;i<buf.length;++i){
    if(buf[i] != search[m]){
      s = -1;
      // <-- go back
      // match abc to aabc
      // 'aabc'
      // 'aab'
      //    ^ no match
      // a'abc'
      //   ^ set index here now and look at these again.
      //   'abc' yay!
      i -= m-1
      m = 0;
    }

    if(buf[i] == search[m]) {
      if(s == -1) s = i;
      ++m;
      if(m == search.length) break;
    }
  }

  if (s > -1 && buf.length - s < search.length) return -1;
  return s;
}


