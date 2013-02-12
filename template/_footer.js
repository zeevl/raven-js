
// Expose Raven to the world
window.Raven = Raven;

// AMD
if (isFunction(window.define) && define.amd) {
    // export Raven before we wrap
    define(function() { return Raven; });

    window.define = wrapArguments(window.define);
    window.require = wrapArguments(window.require);
}

})(window);
