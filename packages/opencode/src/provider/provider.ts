options["fetch"] = timeoutFetch(options)
        delete options["chunkTimeout"]
        delete options["headerTimeout"]