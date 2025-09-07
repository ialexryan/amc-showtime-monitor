(($) => {
  $(document).ready(() => {
    amc.highlightHtml();
  });
})(jQuery);

var amc = (() => ({
  highlightHtml: () => {
    var codeToDisplay = $('[data-language="html"]');
    if (codeToDisplay.length > 0) {
      codeToDisplay.each((index, el) => {
        var exampleCode = $(el),
          highlightedCode = hljs.highlightAuto(exampleCode.html());
        exampleCode.html(highlightedCode.value);
        exampleCode.show();
      });
    }
  },
}))((amc = amc || {}));
