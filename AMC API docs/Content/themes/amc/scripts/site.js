(function ($) {
    $(document).ready(function () {
        amc.highlightHtml();
    });
})(jQuery);

var amc = (function () {
    return {
        highlightHtml: function () {
            var codeToDisplay = $('[data-language="html"]');
            if (codeToDisplay.length > 0) {
                codeToDisplay.each(function (index, el) {
                    var exampleCode = $(el),
                        highlightedCode = hljs.highlightAuto(exampleCode.html());
                    exampleCode.html(highlightedCode.value);
                    exampleCode.show();
                });
            }
        }
    }
}(amc = amc || {}));